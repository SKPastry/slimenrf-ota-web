// SlimeNRF ESB OTA Session Manager — WebHID + OTA protocol flow
// Translates the Python esb_ota.py OTAClient + update flow for WebHID.

import {
  REPORT_SIZE, HID_OTA_FW_INFO, HID_OTA_STATUS,
  OTA_STATUS_READY, OTA_STATUS_RECEIVING, OTA_STATUS_VERIFY_OK,
  OTA_STATUS_VERIFY_FAIL, OTA_STATUS_COMPLETE, OTA_STATUS_ERROR,
  OTA_STATUS_BOARD_MISMATCH, OTA_STATUS_SIZE_ERROR, OTA_STATUS_FLASH_ERROR,
  TERMINAL_STATUSES, STATUS_NAMES,
  OTA_DATA_MAX_PAYLOAD, MAX_IN_FLIGHT, BURST_SIZE,
  RECEIVER_OTA_ID,
  buildQueryInfo, buildBegin, buildData, buildVerify,
  buildActivate, buildAbort,
  parseSubReports, parseStatus, parseFwInfo,
} from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── OTA Session ─────────────────────────────────────────────────────

/**
 * Manages an OTA firmware update session over a WebHID device.
 *
 * Callbacks object:
 *   onLog(message: string)
 *   onProgress({ consumed, total, speed, inFlight })
 *   onPhase(phase: string, step: number)
 *   onTrackerStatus(trackerId: number, statusName: string)
 *   onBatchInfo({ current, total, trackerIds })
 */
export class OTASession {
  constructor(device, callbacks = {}) {
    this.device = device;
    this.cb = callbacks;
    this._reportHandlers = [];
    this._inputHandler = this._onInputReport.bind(this);
    this._aborted = false;
    device.addEventListener('inputreport', this._inputHandler);
  }

  destroy() {
    this.device.removeEventListener('inputreport', this._inputHandler);
    this._reportHandlers = [];
  }

  abort() {
    this._aborted = true;
  }

  // ── Internal helpers ────────────────────────────────────────────

  _log(msg) { this.cb.onLog?.(msg); }

  _onInputReport(event) {
    const dv = event.data;
    const frame = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
    const subs = parseSubReports(frame);
    for (const sub of subs) {
      if (sub[0] >= 0xf0 && sub[0] <= 0xf7) {
        for (const h of this._reportHandlers) h(sub);
      }
    }
  }

  _addHandler(fn) {
    this._reportHandlers.push(fn);
    return () => { this._reportHandlers = this._reportHandlers.filter((h) => h !== fn); };
  }

  async _send(pkt) {
    await this.device.sendReport(0x00, pkt);
  }

  /** Send multiple packets concurrently. */
  async _sendBatch(pkts) {
    await Promise.all(pkts.map(p => this.device.sendReport(0x00, p)));
  }

  /** Collect OTA sub-reports matching `filter` until count or timeout. */
  _collectReports(filter, { timeoutMs = 5000, count = Infinity } = {}) {
    return new Promise((resolve) => {
      const results = [];
      const timer = setTimeout(() => { remove(); resolve(results); }, timeoutMs);
      const remove = this._addHandler((r) => {
        if (filter(r)) {
          results.push(new Uint8Array(r));
          if (results.length >= count) { clearTimeout(timer); remove(); resolve(results); }
        }
      });
    });
  }

  // ── Discover Trackers ───────────────────────────────────────────

  /**
   * Listen for HID reports to discover connected trackers.
   * Returns { [trackerId]: { addr: string, online: boolean } }
   */
  async discoverTrackers(durationMs = 1500) {
    const trackers = {};

    const handler = (event) => {
      const dv = event.data;
      const data = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      for (let off = 0; off < Math.min(data.length, 64); off += 16) {
        const sub = data.subarray(off, off + 16);
        if (sub.length < 8) continue;
        const pktType = sub[0];
        const tid = sub[1];

        if (pktType === 0xff && tid < 64) {
          // Address registration — tracker is registered but may be offline
          const addr = Array.from(sub.slice(2, 8)).reverse()
            .map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
          if (!(tid in trackers)) trackers[tid] = { addr, online: false };
          else trackers[tid].addr = addr;
        } else if (pktType !== 0 && pktType < 0xf0 && tid < 64) {
          // Active data packet — tracker is online
          if (!(tid in trackers)) trackers[tid] = { addr: '', online: true };
          else trackers[tid].online = true;
        }
      }
    };

    this.device.addEventListener('inputreport', handler);
    await sleep(durationMs);
    this.device.removeEventListener('inputreport', handler);
    return trackers;
  }

  // ── Query Firmware Info ─────────────────────────────────────────

  async queryInfo(trackerId, { timeoutMs = 5000 } = {}) {
    await this._send(buildQueryInfo(trackerId));

    const chunks = await this._collectReports(
      (r) => r[0] === HID_OTA_FW_INFO && r[1] === trackerId,
      { timeoutMs, count: 6 },
    );

    if (chunks.length === 0) return null;
    if (chunks.length < 5) {
      this._log(`Tracker ${trackerId}: only ${chunks.length}/6 info chunks received`);
    }
    return parseFwInfo(chunks);
  }

  /**
   * Query firmware info for multiple trackers with limited concurrency.
   * Each tracker has its own timeout. Results stream via onResult callback.
   * Returns { [trackerId]: parsedInfo | null }
   */
  async queryInfoBatch(trackerIds, { onResult, maxParallel = 4, perTimeout = 5000 } = {}) {
    if (trackerIds.length === 0) return {};

    const results = {};

    const queryOne = async (tid) => {
      await this._send(buildQueryInfo(tid));
      const chunks = await this._collectReports(
        (r) => r[0] === HID_OTA_FW_INFO && r[1] === tid,
        { timeoutMs: perTimeout, count: 6 },
      );
      const info = chunks.length > 0 ? parseFwInfo(chunks) : null;
      if (chunks.length > 0 && chunks.length < 5) {
        this._log(`Tracker ${tid}: only ${chunks.length}/6 info chunks received`);
      }
      results[tid] = info;
      if (onResult) onResult(tid, info);
    };

    // Sliding window with concurrency limit
    const queue = [...trackerIds];
    const active = new Set();
    let idx = 0;

    while (idx < queue.length || active.size > 0) {
      while (active.size < maxParallel && idx < queue.length) {
        const tid = queue[idx++];
        const p = queryOne(tid).finally(() => active.delete(p));
        active.add(p);
        if (active.size < maxParallel && idx < queue.length) {
          await sleep(150); // stagger sends within a batch
        }
      }
      if (active.size > 0) {
        await Promise.race(active);
      }
    }

    return results;
  }

  // ── Multi-Status Wait ───────────────────────────────────────────

  /**
   * Wait for specific status from multiple trackers.
   * Optionally resends a command to non-responsive trackers.
   */
  async _waitForMultiStatus(trackerIds, expected, timeoutMs,
                            resendCb = null, resendIntervalMs = 3000) {
    const results = {};
    const pending = new Set(trackerIds);
    const deadline = performance.now() + timeoutMs;
    let nextResend = resendCb ? performance.now() + resendIntervalMs : Infinity;
    let resendCount = 0;

    const remove = this._addHandler((report) => {
      if (report[0] === HID_OTA_STATUS && pending.has(report[1])) {
        const st = parseStatus(report);
        if (st && expected.has(st.status)) {
          results[st.trackerId] = st;
          pending.delete(st.trackerId);
        }
      }
    });

    try {
      while (pending.size > 0 && performance.now() < deadline) {
        if (this._aborted) throw new Error('Aborted');

        // Periodic resend
        if (resendCb && performance.now() >= nextResend) {
          resendCount++;
          for (const tid of pending) {
            await resendCb(tid);
            await sleep(50);
          }
          this._log(`  (retry #${resendCount} for tracker${pending.size > 1 ? 's' : ''} ${[...pending].sort().join(', ')})`);
          nextResend = performance.now() + resendIntervalMs;
        }

        await sleep(100);
      }
    } finally {
      remove();
    }
    return results;
  }

  // ── Stream Data ─────────────────────────────────────────────────

  async _streamData(activeIds, firmware, totalPackets) {
    const imageSize = firmware.data.length;
    let nextSeq = 0;
    const trkSeq = Object.fromEntries(activeIds.map((id) => [id, 0]));
    const failedIds = new Set();
    let warmup = true;
    const t0 = performance.now();

    const remove = this._addHandler((report) => {
      if (report[0] !== HID_OTA_STATUS) return;
      const tid = report[1];
      if (!(tid in trkSeq)) return;
      const st = parseStatus(report);
      if (!st) return;
      if (TERMINAL_STATUSES.has(st.status)) {
        this._log(`Tracker ${tid}: ${st.statusName}`);
        this.cb.onTrackerStatus?.(tid, st.statusName);
        failedIds.add(tid);
        return;
      }
      trkSeq[tid] = st.nextSeq;
      if (warmup && st.nextSeq > 0) warmup = false;
    });

    const alive = () => activeIds.filter((t) => !failedIds.has(t));
    const minSeq = () => Math.min(...alive().map((t) => trkSeq[t] ?? 0));

    let lastProgressTime = 0;
    const reportProgress = (force = false) => {
      const now = performance.now();
      if (!force && now - lastProgressTime < 100) return; // throttle to 10 Hz
      lastProgressTime = now;
      const ids = alive();
      if (ids.length === 0) return;
      const consumed = minSeq();
      const elapsed = (performance.now() - t0) / 1000;
      const bytes = Math.min(consumed * OTA_DATA_MAX_PAYLOAD, imageSize);
      const speed = elapsed > 0 ? bytes / elapsed / 1024 : 0;
      this.cb.onProgress?.({ consumed, total: totalPackets, speed, inFlight: nextSeq - consumed });
    };

    try {
      const maxAttempts = 5;
      let attempt = 0;
      const overallDeadline = performance.now() + 120_000;

      outer:
      while (attempt < maxAttempts && performance.now() < overallDeadline) {
        if (this._aborted) throw new Error('Aborted');
        if (alive().length === 0) { this._log('All trackers failed.'); return false; }

        // ── Streaming phase ───────────────────────────────────
        while (nextSeq < totalPackets && performance.now() < overallDeadline) {
          if (this._aborted) throw new Error('Aborted');
          if (alive().length === 0) return false;

          const consumed = minSeq();
          const inFlight = nextSeq - consumed;

          if (inFlight >= MAX_IN_FLIGHT) {
            await sleep(5);
            reportProgress();
            continue;
          }

          const headroom = MAX_IN_FLIGHT - inFlight;
          const burst = warmup ? Math.min(8, headroom) : Math.min(BURST_SIZE, headroom);

          const pkts = [];
          for (let i = 0; i < burst && nextSeq < totalPackets; i++) {
            const off = nextSeq * OTA_DATA_MAX_PAYLOAD;
            const chunk = firmware.data.subarray(off, off + OTA_DATA_MAX_PAYLOAD);
            pkts.push(buildData(activeIds[0], nextSeq, chunk));
            nextSeq++;
          }
          await this._sendBatch(pkts);

          await sleep(1); // yield for input reports
          reportProgress();
        }

        // ── Gap-fill phase ────────────────────────────────────
        let stallCount = 0;
        let prevMin = -1;
        const gapDeadline = performance.now() + 15_000;

        while (performance.now() < gapDeadline) {
          if (this._aborted) throw new Error('Aborted');
          if (alive().length === 0) return false;

          const consumed = minSeq();
          if (consumed >= totalPackets) break outer;

          await sleep(200);

          const newMin = minSeq();
          if (newMin >= totalPackets) break outer;

          if (newMin === prevMin) {
            stallCount++;
            const currentInFlight = nextSeq - newMin;
            if (stallCount >= 5 && currentInFlight === 0) {
              const rem = totalPackets - newMin;
              this._log(`Gap-fill #${attempt + 1}: resending from seq ${newMin} (${rem} remaining)`);
              nextSeq = newMin;
              warmup = false;
              attempt++;
              continue outer;
            }
          } else {
            stallCount = 0;
          }
          prevMin = newMin;
          reportProgress();
        }

        // If gap timeout expired without resolving, break
        if (minSeq() < totalPackets) break;
      }

      const elapsed = (performance.now() - t0) / 1000;
      const perTracker = imageSize / elapsed / 1024;
      const nActive = alive().length;
      this._log(
        `Transfer complete: ${(imageSize / 1024).toFixed(1)} KB in ${elapsed.toFixed(1)}s ` +
        `(${perTracker.toFixed(1)} KB/s per tracker, ${(perTracker * nActive).toFixed(1)} KB/s total)`
      );
      return alive().length > 0;

    } finally {
      remove();
    }
  }

  // ── Full Update Flow ────────────────────────────────────────────

  /**
   * Perform OTA update for a batch of trackers with the same firmware.
   * Returns true if at least one tracker was updated successfully.
   */
  async performUpdate(trackerIds, firmware, boardTarget) {
    this._aborted = false;
    const totalPackets = Math.ceil(firmware.data.length / OTA_DATA_MAX_PAYLOAD);
    const imageSize = firmware.data.length;

    this._log(`\n${'═'.repeat(50)}`);
    this._log(`ESB OTA Update — ${trackerIds.length} tracker(s): ${trackerIds.join(', ')}`);
    this._log(`Board: ${boardTarget}  Size: ${(imageSize / 1024).toFixed(1)} KB  CRC: 0x${firmware.crc32.toString(16).toUpperCase().padStart(8, '0')}`);
    this._log(`${'═'.repeat(50)}`);

    // ── Step 1: BEGIN ─────────────────────────────────────────
    this.cb.onPhase?.('begin', 1);
    this._log(`[1/4] Sending BEGIN to ${trackerIds.length} tracker(s)…`);

    for (const tid of trackerIds) {
      await this._send(buildBegin(tid, imageSize, firmware.crc32,
        totalPackets, boardTarget, firmware.baseAddress));
      await sleep(50);
    }

    const readyExpected = new Set([
      OTA_STATUS_READY, OTA_STATUS_RECEIVING,
      OTA_STATUS_BOARD_MISMATCH, OTA_STATUS_SIZE_ERROR, OTA_STATUS_ERROR,
    ]);

    const readyResults = await this._waitForMultiStatus(
      trackerIds, readyExpected, 15_000,
      async (tid) => {
        await this._send(buildBegin(tid, imageSize, firmware.crc32,
          totalPackets, boardTarget, firmware.baseAddress));
      },
      3000,
    );

    const activeIds = [];
    for (const tid of trackerIds) {
      const st = readyResults[tid];
      if (!st) {
        this._log(`  Tracker ${tid}: No response (skipping)`);
        this.cb.onTrackerStatus?.(tid, 'No Response');
      } else if (TERMINAL_STATUSES.has(st.status) ||
                 (st.status !== OTA_STATUS_READY && st.status !== OTA_STATUS_RECEIVING)) {
        this._log(`  Tracker ${tid}: Rejected (${st.statusName})`);
        this.cb.onTrackerStatus?.(tid, st.statusName);
      } else {
        this._log(`  Tracker ${tid}: Ready`);
        this.cb.onTrackerStatus?.(tid, 'Ready');
        activeIds.push(tid);
      }
    }

    if (activeIds.length === 0) {
      this._log('Error: No trackers ready for update.');
      await this._send(buildAbort(0xff));
      return false;
    }

    // ── Step 2: Stream DATA ───────────────────────────────────
    this.cb.onPhase?.('stream', 2);
    this._log(`[2/4] Streaming firmware to ${activeIds.length} tracker(s)…`);

    for (const tid of activeIds) this.cb.onTrackerStatus?.(tid, 'Receiving');

    const streamOk = await this._streamData(activeIds, firmware, totalPackets);
    if (!streamOk) {
      await this._send(buildAbort(0xff));
      return false;
    }

    // ── Step 3: Verify CRC32 ──────────────────────────────────
    this.cb.onPhase?.('verify', 3);
    this._log('[3/4] Requesting CRC32 verification…');
    await sleep(500);

    for (const tid of activeIds) {
      await this._send(buildVerify(tid));
      await sleep(50);
    }
    for (const tid of activeIds) this.cb.onTrackerStatus?.(tid, 'Verifying');

    const verifyExpected = new Set([OTA_STATUS_VERIFY_OK, OTA_STATUS_VERIFY_FAIL, OTA_STATUS_ERROR]);
    const verifyResults = await this._waitForMultiStatus(
      activeIds, verifyExpected, 30_000,
      async (tid) => { await this._send(buildVerify(tid)); },
      3000,
    );

    const verifiedIds = [];
    for (const tid of activeIds) {
      const st = verifyResults[tid];
      if (!st) {
        this._log(`  Tracker ${tid}: No verification response`);
        this.cb.onTrackerStatus?.(tid, 'Verify Timeout');
      } else if (st.status !== OTA_STATUS_VERIFY_OK) {
        this._log(`  Tracker ${tid}: Verification FAILED (${st.statusName})`);
        this.cb.onTrackerStatus?.(tid, st.statusName);
      } else {
        this._log(`  Tracker ${tid}: CRC32 verified ✓`);
        this.cb.onTrackerStatus?.(tid, 'Verified');
        verifiedIds.push(tid);
      }
    }

    if (verifiedIds.length === 0) {
      this._log('Error: No trackers passed verification.');
      await this._send(buildAbort(0xff));
      return false;
    }

    // ── Step 4: Activate ──────────────────────────────────────
    this.cb.onPhase?.('activate', 4);
    this._log(`[4/4] Activating firmware on ${verifiedIds.length} tracker(s)…`);

    for (const tid of verifiedIds) {
      await this._send(buildActivate(tid));
      await sleep(50);
    }
    for (const tid of verifiedIds) this.cb.onTrackerStatus?.(tid, 'Activating');

    const actExpected = new Set([OTA_STATUS_COMPLETE, OTA_STATUS_ERROR, OTA_STATUS_FLASH_ERROR]);
    const actResults = await this._waitForMultiStatus(
      verifiedIds, actExpected, 15_000,
      async (tid) => { await this._send(buildActivate(tid)); },
      3000,
    );

    let ok = 0;
    for (const tid of verifiedIds) {
      const st = actResults[tid];
      if (!st) {
        this._log(`  Tracker ${tid}: No response (rebooted — OK)`);
        this.cb.onTrackerStatus?.(tid, 'Complete');
        ok++;
      } else if (st.status === OTA_STATUS_COMPLETE) {
        this._log(`  Tracker ${tid}: Firmware activated, rebooting!`);
        this.cb.onTrackerStatus?.(tid, 'Complete');
        ok++;
      } else {
        this._log(`  Tracker ${tid}: Activation failed (${st.statusName})`);
        this.cb.onTrackerStatus?.(tid, st.statusName);
      }
    }

    await this._send(buildAbort(0xff));
    return ok > 0;
  }

  // ── Receiver Self-OTA ───────────────────────────────────────────

  /**
   * Query firmware info from the receiver itself.
   */
  async queryReceiverInfo({ timeoutMs = 5000 } = {}) {
    return this.queryInfo(RECEIVER_OTA_ID, { timeoutMs });
  }

  /**
   * Perform OTA update on the receiver itself.
   * Simpler than tracker OTA: direct HID, no ring buffer / ESB relay.
   *
   * Callbacks: same as performUpdate, plus the receiver shows as
   * trackerId = RECEIVER_OTA_ID (0xFE) in status callbacks.
   */
  async performReceiverUpdate(firmware, boardTarget) {
    this._aborted = false;
    const totalPackets = Math.ceil(firmware.data.length / OTA_DATA_MAX_PAYLOAD);
    const imageSize = firmware.data.length;
    const tid = RECEIVER_OTA_ID;

    this._log(`\n${'═'.repeat(50)}`);
    this._log(`Receiver Self-OTA Update`);
    this._log(`Board: ${boardTarget}  Size: ${(imageSize / 1024).toFixed(1)} KB  CRC: 0x${firmware.crc32.toString(16).toUpperCase().padStart(8, '0')}`);
    this._log(`${'═'.repeat(50)}`);

    // ── Step 1: BEGIN ─────────────────────────────────────────
    this.cb.onPhase?.('begin', 1);
    this._log('[1/4] Sending BEGIN to receiver…');

    await this._send(buildBegin(tid, imageSize, firmware.crc32,
      totalPackets, boardTarget, firmware.baseAddress));

    const readyExpected = new Set([
      OTA_STATUS_READY, OTA_STATUS_RECEIVING,
      OTA_STATUS_BOARD_MISMATCH, OTA_STATUS_SIZE_ERROR, OTA_STATUS_ERROR,
    ]);

    const readyResults = await this._waitForMultiStatus(
      [tid], readyExpected, 10_000,
      async () => {
        await this._send(buildBegin(tid, imageSize, firmware.crc32,
          totalPackets, boardTarget, firmware.baseAddress));
      },
      3000,
    );

    const st = readyResults[tid];
    if (!st) {
      this._log('Error: No response from receiver');
      return false;
    }
    if (st.status !== OTA_STATUS_READY && st.status !== OTA_STATUS_RECEIVING) {
      this._log(`Error: Receiver rejected OTA (${st.statusName})`);
      this.cb.onTrackerStatus?.(tid, st.statusName);
      return false;
    }
    this._log('  Receiver ready');
    this.cb.onTrackerStatus?.(tid, 'Ready');

    // ── Step 2: Stream DATA (simple sequential) ───────────────
    this.cb.onPhase?.('stream', 2);
    this._log('[2/4] Streaming firmware to receiver…');
    this.cb.onTrackerStatus?.(tid, 'Receiving');

    const t0 = performance.now();
    let failed = false;

    // Listen for error statuses during transfer
    const remove = this._addHandler((report) => {
      if (report[0] === HID_OTA_STATUS && report[1] === tid) {
        const rSt = parseStatus(report);
        if (rSt && TERMINAL_STATUSES.has(rSt.status)) {
          this._log(`Receiver error: ${rSt.statusName}`);
          this.cb.onTrackerStatus?.(tid, rSt.statusName);
          failed = true;
        }
      }
    });

    try {
      for (let seq = 0; seq < totalPackets; seq++) {
        if (this._aborted) throw new Error('Aborted');
        if (failed) return false;

        const off = seq * OTA_DATA_MAX_PAYLOAD;
        const chunk = firmware.data.subarray(off, off + OTA_DATA_MAX_PAYLOAD);
        await this._send(buildData(tid, seq, chunk));

        // Progress
        if ((seq + 1) % 20 === 0 || seq === totalPackets - 1) {
          const elapsed = (performance.now() - t0) / 1000;
          const bytesSent = Math.min((seq + 1) * OTA_DATA_MAX_PAYLOAD, imageSize);
          const speed = elapsed > 0 ? bytesSent / elapsed / 1024 : 0;
          this.cb.onProgress?.({
            consumed: seq + 1,
            total: totalPackets,
            speed,
            inFlight: 0,
          });
        }

        // Brief yield every packet for input reports
        if ((seq + 1) % 5 === 0) await sleep(1);
      }
    } finally {
      remove();
    }

    if (failed) return false;

    const elapsed = (performance.now() - t0) / 1000;
    this._log(
      `Transfer complete: ${(imageSize / 1024).toFixed(1)} KB in ${elapsed.toFixed(1)}s ` +
      `(${(imageSize / elapsed / 1024).toFixed(1)} KB/s)`
    );

    // ── Step 3: Verify CRC32 ──────────────────────────────────
    this.cb.onPhase?.('verify', 3);
    this._log('[3/4] Requesting CRC32 verification…');
    await sleep(500);

    await this._send(buildVerify(tid));
    this.cb.onTrackerStatus?.(tid, 'Verifying');

    const verifyExpected = new Set([OTA_STATUS_VERIFY_OK, OTA_STATUS_VERIFY_FAIL, OTA_STATUS_ERROR]);
    const verifyResults = await this._waitForMultiStatus(
      [tid], verifyExpected, 30_000,
      async () => { await this._send(buildVerify(tid)); },
      3000,
    );

    const vSt = verifyResults[tid];
    if (!vSt) {
      this._log('Error: No verification response from receiver');
      await this._send(buildAbort(tid));
      return false;
    }
    if (vSt.status !== OTA_STATUS_VERIFY_OK) {
      this._log(`Verification FAILED (${vSt.statusName})`);
      this.cb.onTrackerStatus?.(tid, vSt.statusName);
      await this._send(buildAbort(tid));
      return false;
    }
    this._log('  CRC32 verified ✓');
    this.cb.onTrackerStatus?.(tid, 'Verified');

    // ── Step 4: Activate ──────────────────────────────────────
    this.cb.onPhase?.('activate', 4);
    this._log('[4/4] Activating new firmware…');

    await this._send(buildActivate(tid));
    this.cb.onTrackerStatus?.(tid, 'Activating');

    // Receiver will flash-copy and reset — USB will disconnect
    await sleep(2000);
    this._log('Receiver is updating and rebooting…');
    this.cb.onTrackerStatus?.(tid, 'Complete');

    this._log(`\n${'═'.repeat(50)}`);
    this._log('Receiver OTA update completed!');
    this._log('The receiver should reboot with the new firmware.');
    this._log(`${'═'.repeat(50)}`);
    return true;
  }
}
