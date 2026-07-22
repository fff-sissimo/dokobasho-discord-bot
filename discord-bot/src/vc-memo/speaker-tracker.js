const logger = require('../logger');

const speakerMap = new Map();
let counter = 0;

function reset() {
  speakerMap.clear();
  counter = 0;
}

function getSpeakerId(userId) {
  if (!speakerMap.has(userId)) {
    counter += 1;
    speakerMap.set(userId, `speaker-${counter}`);
    logger.debug(
      { speakerId: speakerMap.get(userId) },
      '[vc-memo] new speaker mapped'
    );
  }
  return speakerMap.get(userId);
}

function getSpeakerLabel(userId) {
  return getSpeakerId(userId);
}

module.exports = {
  reset,
  getSpeakerId,
  getSpeakerLabel,
};
