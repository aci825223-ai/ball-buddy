const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createAiStorage(directory) {
  const chatsDirectory = path.join(directory, 'chats');
  fs.mkdirSync(chatsDirectory, { recursive: true });
  function parse(file) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI record');
    return value;
  }
  function read(file) {
    try { return parse(file); }
    catch (error) {
      if (error.code !== 'ENOENT') {
        try { fs.copyFileSync(file, `${file}.recovery-${Date.now()}-${randomUUID()}`); } catch { /* Preserve the original as well. */ }
      }
      try { return parse(`${file}.backup`); } catch { return null; }
    }
  }
  function write(file, value) {
    if (fs.existsSync(file)) {
      try { parse(file); fs.copyFileSync(file, `${file}.backup`); }
      catch (error) { if (error.code && error.code !== 'ENOENT') throw error; }
    }
    const temporary = `${file}.tmp-${randomUUID()}`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  }
  function chatFile(chatId) { return path.join(chatsDirectory, `${chatId}.json`); }
  return {
    readConfig() { return read(path.join(directory, 'config.json')); },
    writeConfig(value) { write(path.join(directory, 'config.json'), value); },
    readChats() {
      const ids = new Set(fs.readdirSync(chatsDirectory).map(name => name.match(/^([0-9a-f-]{36})\.json(?:\.backup)?$/i)?.[1]).filter(Boolean));
      return [...ids].map(chatId => read(chatFile(chatId))).filter(Boolean);
    },
    writeChat(chat) { write(chatFile(chat.id), chat); }
  };
}
module.exports = { createAiStorage };
