/// <reference types="react-scripts" />

// Safari's older name for AudioContext
interface Window {
  webkitAudioContext?: typeof AudioContext;
}
