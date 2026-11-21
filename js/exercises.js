// Exercise registry. Every entry has a `group` (the exercise) and a `view` (where the camera is: side / front).
// To add one: write a module like squat.js / curl_front.js and list it here.
import { curl } from './curl.js';
import { curlFront } from './curl_front.js';
import { squatFront } from './front.js';
import { squat } from './squat.js';

export const EXERCISES = { squat, 'squat-front': squatFront, curl, 'curl-front': curlFront };
export const DEFAULT_EXERCISE = 'squat';

/** The exercise for a group and camera view (falls back to the group's first view). */
export function findExercise(group, view) {
  const inGroup = Object.values(EXERCISES).filter((e) => e.group === group);
  return inGroup.find((e) => e.view === view) || inGroup[0];
}
