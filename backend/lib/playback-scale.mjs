// Positive rates play forward; negative rates request reverse from the device.
// A device may still reject a supported request rate at the protocol layer.
export const playbackScales = Object.freeze([
  0.25, 0.5, 1, 2, 4, 8, 16, -1, -2, -4, -8, -16,
]);
export const validPlaybackScale = (value) =>
  typeof value === "number" && playbackScales.includes(value);
