import type { CameraCorner, CameraShape, CameraSize } from "@zapture/recorder-core";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraBubble extends Rect {
  /** Corner radius in the same units as the rect; circles use half the height. */
  radius: number;
}

/** Bubble height as a fraction of the frame width. Must match the editor and render worker. */
export const CAMERA_SIZE_RATIOS = { small: 0.14, medium: 0.2, large: 0.27 } as const;
const MARGIN_RATIO = 0.025;
const ROUNDED_ASPECT = 4 / 3;
const ROUNDED_RADIUS_RATIO = 0.16;

/** Width, height and corner radius of a bubble whose height is `height`. */
export function cameraShapeBox(height: number, shape: CameraShape) {
  const d = Math.round(height);
  return shape === "circle"
    ? { width: d, height: d, radius: d / 2 }
    : { width: Math.round(d * ROUNDED_ASPECT), height: d, radius: Math.round(ROUNDED_RADIUS_RATIO * d) };
}

/** Bubble placement in a frame of `frameWidth` x `frameHeight`, in frame pixels. */
export function cameraBubbleRect(
  frameWidth: number,
  frameHeight: number,
  size: Exclude<CameraSize, "off">,
  corner: CameraCorner,
  shape: CameraShape,
): CameraBubble {
  const box = cameraShapeBox(frameWidth * CAMERA_SIZE_RATIOS[size], shape);
  const margin = Math.round(frameWidth * MARGIN_RATIO);
  return {
    ...box,
    x: corner.endsWith("right") ? frameWidth - box.width - margin : margin,
    y: corner.startsWith("bottom") ? frameHeight - box.height - margin : margin,
  };
}

/** The box an `object-fit: contain` image of natural size `imageWidth` x `imageHeight` occupies inside its container. */
export function containedImageRect(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number): Rect {
  if (!(containerWidth > 0 && containerHeight > 0 && imageWidth > 0 && imageHeight > 0)) {
    return { x: 0, y: 0, width: Math.max(0, containerWidth), height: Math.max(0, containerHeight) };
  }
  const scale = Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return { x: (containerWidth - width) / 2, y: (containerHeight - height) / 2, width, height };
}

/** Bubble placement in container coordinates for a thumbnail whose image is letterboxed inside the container. */
export function thumbnailBubbleRect(
  container: { width: number; height: number },
  image: { width: number; height: number },
  size: Exclude<CameraSize, "off">,
  corner: CameraCorner,
  shape: CameraShape,
): CameraBubble {
  const shown = containedImageRect(container.width, container.height, image.width, image.height);
  const bubble = cameraBubbleRect(image.width, image.height, size, corner, shape);
  const scale = image.width > 0 ? shown.width / image.width : 0;
  return {
    x: shown.x + bubble.x * scale,
    y: shown.y + bubble.y * scale,
    width: bubble.width * scale,
    height: bubble.height * scale,
    radius: bubble.radius * scale,
  };
}
