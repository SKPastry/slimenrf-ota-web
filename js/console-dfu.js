// Application-console handshake only; bootloader verification happens in Serial DFU.
const IO_TIMEOUT_MS = 2000;
const READY_TIMEOUT_MS = 8000;
const OUTCOME_TIMEOUT_MS = 5000;

async function bounded(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own an already selected port until command entry, disconnect, or failure. */
export async function requestConsoleDfu(port, serial, t, onReady) {
  let reader;
  let writer;
  let reading;
  let opened = false;
  let stopping = false;
  let disconnected = false;
  let readError;
  let ready = false;
  let sent = false;
  let entered = false;
  let rejected = false;
  let line = '';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const onDisconnect = (event) => {
    if (event.target === port || event.port === port) disconnected = true;
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 50));
  const io = operation => bounded(operation, IO_TIMEOUT_MS, t('receiver.dfuIoTimeout'));
  serial.addEventListener('disconnect', onDisconnect);
  try {
    // If open finishes after its deadline, still release the acquired port.
    const opening = port.open({ baudRate: 115200 });
    opening.then(() => {
      if (stopping) {
        void port.close().catch(() => {});
      } else {
        opened = true;
      }
    }, () => {});
    await io(opening);
    reader = port.readable.getReader();
    writer = port.writable.getWriter();
    reading = (async () => {
      try {
        while (!stopping) {
          const { value, done } = await reader.read();
          if (done) {
            if (!stopping) readError = new Error(t('receiver.dfuReadEnded'));
            break;
          }
          // Keep only a bounded line, preserving decoder state across USB chunks.
          for (const char of decoder.decode(value, { stream: true })) {
            if (char === '\r' || char === '\n') {
              const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
              // The read-only command's response, never its echo or a banner.
              if (/^Uptime:\s*\d/.test(text)) ready = true;
              if (sent && /^Entering DFU bootloader\.{0,3}$/.test(text)) entered = true;
              if (sent && /^(DFU not available on this build|Unknown command|Unknown dfu argument:.*)$/.test(text)) rejected = true;
              line = '';
            } else {
              line = (line + char).slice(-512);
            }
          }
        }
      } catch (error) {
        if (!stopping) readError = error;
      }
    })();
    await io(port.setSignals({ dataTerminalReady: true }));

    const readyDeadline = performance.now() + READY_TIMEOUT_MS;
    let nextProbe = 0;
    while (!ready) {
      if (disconnected || readError) throw readError || new Error(t('receiver.dfuEarlyDisconnect'));
      if (performance.now() >= readyDeadline) throw new Error(t('receiver.dfuReadyTimeout'));
      if (performance.now() >= nextProbe) {
        // Startup deliberately discards stale RX. Poll a harmless command until
        // firmware actually executes it, including older consoles without banners.
        await io(writer.write(encoder.encode('\r\nuptime\r\n')));
        nextProbe = performance.now() + 500;
      }
      await pause();
    }
    if (disconnected || readError) throw readError || new Error(t('receiver.dfuEarlyDisconnect'));
    onReady();
    line = '';
    sent = true;
    const outcomeDeadline = performance.now() + OUTCOME_TIMEOUT_MS;
    let writeError;
    try {
      await io(writer.write(encoder.encode('dfu\r\n')));
    } catch (error) {
      // USB may disappear during write. Only independent observation below can
      // make this an entry/disconnect outcome rather than a failed write.
      writeError = error;
    }
    while (!entered && !disconnected && !rejected && performance.now() < outcomeDeadline) {
      await pause();
    }
    if (rejected) throw new Error(t('receiver.dfuRejected'));
    if (entered) return 'entered';
    if (disconnected) return 'disconnected';
    throw writeError || readError || new Error(t('receiver.dfuOutcomeTimeout'));
  } finally {
    stopping = true;
    serial.removeEventListener('disconnect', onDisconnect);
    // Cancel/abort instead of flushing indefinitely after a reset or timeout.
    await Promise.all([
      reader ? io(reader.cancel()).catch(() => {}) : undefined,
      writer ? io(writer.abort()).catch(() => {}) : undefined,
    ]);
    try { reader?.releaseLock(); } catch {}
    try { writer?.releaseLock(); } catch {}
    if (reading) await io(reading).catch(() => {});
    if (opened) await io(port.close()).catch(() => {});
  }
}
