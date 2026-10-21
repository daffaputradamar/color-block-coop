// Runs the endless-level generator off the server's main thread.
import { parentPort, workerData } from 'node:worker_threads';
import { generateLevel } from './generator.js';

parentPort.postMessage(generateLevel(workerData.stage, workerData.seed));
