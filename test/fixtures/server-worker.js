import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/database.js';
import { createService } from '../../src/service.js';
import { createHttpServer } from '../../src/http.js';

// Each worker has its own event loop and SQLite connection to the same file.
const db = openDatabase(workerData);
const server = createHttpServer(createService(db));
server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ base: `http://127.0.0.1:${server.address().port}` });
});
parentPort.once('message', () => {
  server.close(() => {
    db.close();
    parentPort.close();
  });
  server.closeAllConnections();
});
