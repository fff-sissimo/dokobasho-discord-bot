const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const cacheDir = process.env.VC_MEMO_CACHE_DIR || '.cache/vc-memo-drafts';

function _sessionDir(sessionId) {
  return path.join(cacheDir, sessionId);
}

function _draftPath(sessionId) {
  return path.join(_sessionDir(sessionId), 'summary-draft.md');
}

function writeDraft(sessionId, content) {
  const dir = _sessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = _draftPath(sessionId);
  fs.writeFileSync(filePath, content, 'utf8');
  logger.info({ sessionId }, '[vc-memo] draft written');
  return filePath;
}

function readDraft(sessionId) {
  const filePath = _draftPath(sessionId);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn({ sessionId }, '[vc-memo] draft not found');
    return null;
  }
}

function deleteDraft(sessionId) {
  const dir = _sessionDir(sessionId);
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info({ sessionId }, '[vc-memo] draft deleted');
      return true;
    }
    return false;
  } catch (err) {
    logger.error({ sessionId, err }, '[vc-memo] failed to delete draft');
    return false;
  }
}

module.exports = {
  writeDraft,
  readDraft,
  deleteDraft,
};
