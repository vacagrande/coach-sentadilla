// Exercise registry. To add one: write a module like squat.js / curl.js and list it here.
import { curl } from './curl.js';
import { squat } from './squat.js';

export const EXERCISES = { squat, curl };
export const DEFAULT_EXERCISE = 'squat';
