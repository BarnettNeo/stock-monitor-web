/**
 * Aliyun ASR AudioWorkletProcessor
 *
 * 替代已弃用的 ScriptProcessorNode，在 AudioWorklet 线程中
 * 累积 PCM 数据并以 4096 采样点为粒度发送回主线程。
 */
class AliyunASRProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {number[]} */
    this._buffer = [];
    this._BUFFER_SIZE = 4096;
  }

  /**
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} outputs
   * @param {Record<string, Float32Array>} parameters
   * @returns {boolean}
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      for (let i = 0; i < channel.length; i++) {
        this._buffer.push(channel[i]);
      }

      while (this._buffer.length >= this._BUFFER_SIZE) {
        const chunk = new Float32Array(this._BUFFER_SIZE);
        for (let i = 0; i < this._BUFFER_SIZE; i++) {
          chunk[i] = this._buffer[i];
        }
        this._buffer.splice(0, this._BUFFER_SIZE);
        this.port.postMessage(chunk);
      }
    }
    return true;
  }
}

registerProcessor('aliyun-asr-processor', AliyunASRProcessor);
