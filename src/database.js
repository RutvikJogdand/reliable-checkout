import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { integer } from './errors.js';

// Keep callbacks synchronous: awaiting inside this boundary would release control
// while a shared connection still had an open transaction.
export function transaction(db, work, { readOnly = false } = {}) {
  db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result && typeof result.then === 'function') {
      throw new TypeError('Transaction callbacks must be synchronous.');
    }
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase({ path = ':memory:', rewardEvery = 5,
  discountPercent = 10, timeout = 2000 } = {}) {
  integer(rewardEvery, 'REWARD_EVERY', 1, 1_000_000);
  integer(discountPercent, 'DISCOUNT_PERCENT', 1, 100);
  integer(timeout, 'Database timeout', 0, 60_000);
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path, { timeout, enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    transaction(db, () => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version === 0) {
        db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
        db.prepare('INSERT INTO settings VALUES (1, ?, ?)').run(rewardEvery, discountPercent);
        const insert = db.prepare('INSERT INTO products VALUES (?, ?, ?, ?)');
        for (const row of [
          ['coffee', 'Coffee beans', 49900, 50],
          ['mug', 'Ceramic mug', 34900, 20],
          ['notebook', 'Notebook', 12900, 100],
          ['lamp', 'Desk lamp (limited stock)', 149900, 1],
          ['sticker', 'Sticker', 105, 200],
        ]) insert.run(...row);
      } else if (version !== 1) {
        throw new Error(`Unsupported database schema version: ${version}`);
      }
      const saved = db.prepare('SELECT * FROM settings WHERE id = 1').get();
      if (saved.reward_every !== rewardEvery || saved.discount_percent !== discountPercent) {
        throw new Error('Reward configuration differs from this database. Use its original settings or a new DB_PATH.');
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
