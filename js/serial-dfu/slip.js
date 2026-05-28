// SLIP (Serial Line Internet Protocol) framing
// RFC 1055 — shared by both Adafruit and Nordic DFU protocols

const END     = 0xC0;
const ESC     = 0xDB;
const ESC_END = 0xDC;
const ESC_ESC = 0xDD;

/**
 * SLIP-encode a byte array. Does NOT add frame delimiters (0xC0).
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function slipEncode(data) {
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === END) {
      out.push(ESC, ESC_END);
    } else if (b === ESC) {
      out.push(ESC, ESC_ESC);
    } else {
      out.push(b);
    }
  }
  return new Uint8Array(out);
}

/**
 * SLIP-decode a byte array. Input should NOT include frame delimiters.
 * @param {Uint8Array|number[]} data
 * @returns {Uint8Array}
 */
export function slipDecode(data) {
  const out = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i++];
    if (b === ESC) {
      if (i >= data.length) throw new Error('SLIP: ESC at end of data');
      const b2 = data[i++];
      if (b2 === ESC_END)      out.push(END);
      else if (b2 === ESC_ESC) out.push(ESC);
      else throw new Error(`SLIP: ESC followed by unexpected byte 0x${b2.toString(16)}`);
    } else {
      out.push(b);
    }
  }
  return new Uint8Array(out);
}

/**
 * Wrap payload in SLIP frame: [0xC0] [SLIP-encoded data] [0xC0]
 * @param {Uint8Array|number[]} data - raw payload (will be SLIP-encoded)
 * @returns {Uint8Array}
 */
export function slipFrame(data) {
  const encoded = slipEncode(data);
  const frame = new Uint8Array(encoded.length + 2);
  frame[0] = END;
  frame.set(encoded, 1);
  frame[frame.length - 1] = END;
  return frame;
}

/**
 * Stateful SLIP decoder for streaming serial data.
 * Feed bytes one at a time; emits decoded packets.
 */
export class SlipDecoder {
  constructor() {
    this._buf = [];
    this._escaping = false;
    this._started = false;
  }

  /**
   * Feed raw bytes from serial port.
   * @param {Uint8Array} chunk
   * @returns {Uint8Array[]} array of decoded packets (0 or more)
   */
  feed(chunk) {
    const packets = [];
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === END) {
        if (this._started && this._buf.length > 0) {
          packets.push(new Uint8Array(this._buf));
        }
        this._buf = [];
        this._escaping = false;
        this._started = true;
        continue;
      }
      if (!this._started) continue;
      if (this._escaping) {
        this._escaping = false;
        if (b === ESC_END)      this._buf.push(END);
        else if (b === ESC_ESC) this._buf.push(ESC);
        else {
          // Invalid escape — discard packet
          this._buf = [];
          this._started = false;
        }
      } else if (b === ESC) {
        this._escaping = true;
      } else {
        this._buf.push(b);
      }
    }
    return packets;
  }

  reset() {
    this._buf = [];
    this._escaping = false;
    this._started = false;
  }
}

export { END, ESC, ESC_END, ESC_ESC };
