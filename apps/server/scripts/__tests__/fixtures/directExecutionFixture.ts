import { isDirectExecution } from '../../scriptSupport.ts';

console.log(isDirectExecution(import.meta.url) ? 'direct' : 'imported');
