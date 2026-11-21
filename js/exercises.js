// Exercise registry. To add one: write a module like squat.js / curl.js and list it here.
// Entries that share a `group` are views of the same exercise (the app shows them as a "Vista" switch).
import { curl } from './curl.js';
import { squatFront } from './front.js';
import { squat } from './squat.js';

export const EXERCISES = { squat, 'squat-front': squatFront, curl };
export const DEFAULT_EXERCISE = 'squat';
