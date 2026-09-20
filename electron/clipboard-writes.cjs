// Reserve at user intent, commit after preparation. A slow download must not
// replace newer text, and an in-flight native FileDrop write must finish first.
class ClipboardWrites {
  constructor() { this.revision = 0; this.pending = Promise.resolve(); }
  reserve() { return ++this.revision; }
  commit(revision, write) {
    const result = this.pending.then(async () => {
      if (revision !== this.revision) return false;
      await write();
      return revision === this.revision;
    });
    this.pending = result.catch(() => {});
    return result;
  }
}
module.exports = { ClipboardWrites };
