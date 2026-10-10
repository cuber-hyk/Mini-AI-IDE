/* 工具完成和设置预听共用同一短音；调用方负责用户手势、配置与事件资格。 */
(function () {
  'use strict';
  window.createToolCompletionSound = function () {
    let context;
    return {
      async prepare() {
        if (!context) context = new window.AudioContext();
        if (context.state === 'suspended') await context.resume();
        if (context.state !== 'running') throw new Error('Audio is unavailable');
        return context;
      },
      play(prepared) {
        const tone = prepared.createOscillator(), gain = prepared.createGain(), now = prepared.currentTime;
        tone.type = 'sine'; tone.frequency.setValueAtTime(660, now);
        gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(0.035, now + 0.015); gain.gain.linearRampToValueAtTime(0, now + 0.15);
        tone.connect(gain); gain.connect(prepared.destination);
        tone.onended = function () { tone.disconnect(); gain.disconnect(); };
        tone.start(now); tone.stop(now + 0.15);
      },
      dispose() { if (context && context.state !== 'closed') void context.close().catch(function () {}); },
    };
  };
})();
