import * as path from 'path';

// it will import the compiled js file from dist directory
export const workerThreadFilePath = path.join(__dirname, 'computeMap.js');
export const historicWorkerThreadFilePath = path.join(__dirname, 'computeHistoric.js');