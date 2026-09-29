export type ReceiptPoint = { x: number; y: number };
export type ReceiptRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  polygon: ReceiptPoint[];
};

type Component = {
  area: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  rowLeft: Uint16Array;
  rowRight: Uint16Array;
};

function convexHull(points: ReceiptPoint[]): ReceiptPoint[] {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const turn = (a: ReceiptPoint, b: ReceiptPoint, c: ReceiptPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const lower: ReceiptPoint[] = [];
  const upper: ReceiptPoint[] = [];
  for (const point of points) {
    while (lower.length > 1 && turn(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    while (upper.length > 1 && turn(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(points: ReceiptPoint[]): number {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    twiceArea += points[i].x * next.y - next.x * points[i].y;
  }
  return Math.abs(twiceArea) / 2;
}

function paperOutline(paper: Component, width: number, height: number): ReceiptPoint[] | undefined {
  const inset = Math.min(2, (paper.right - paper.left) * 0.02, (paper.bottom - paper.top) * 0.02);
  const median = (rows: Uint16Array, y: number) => {
    const neighbors = Array.from(
      rows.slice(Math.max(paper.top, y - 2), Math.min(paper.bottom, y + 3)),
    );
    neighbors.sort((a, b) => a - b);
    return neighbors[Math.floor(neighbors.length / 2)];
  };
  const left: ReceiptPoint[] = [];
  const right: ReceiptPoint[] = [];
  // Keep photo boundaries intact when the paper continues outside the image.
  const top = paper.top + (paper.top > 0 ? 1 : 0);
  const bottom = paper.bottom - (paper.bottom < height ? 1 : 0);
  for (let y = top; y < bottom; y++) {
    const from = paper.rowLeft[y] === 0 ? 0 : median(paper.rowLeft, y) + inset;
    const to = paper.rowRight[y] === width ? width : median(paper.rowRight, y) - inset;
    if (to <= from) continue;
    left.push({ x: from, y: y + 0.5 });
    right.push({ x: to, y: y + 0.5 });
  }
  if (left.length < 2) return undefined;
  // This outline may be concave: a convex hull would bridge the curved edge of a real receipt
  // and reintroduce textured background beside the printed rows. Interior holes stay filled.
  return [
    { x: left[0].x, y: top },
    ...left,
    { x: left.at(-1)!.x, y: bottom },
    { x: right.at(-1)!.x, y: bottom },
    ...right.reverse(),
    { x: right.at(-1)!.x, y: top },
  ];
}

/**
 * Locate one clearly contrasted sheet in an RGBA thumbnail, without decoding the source photo.
 * Coordinates refer to pixel edges in this thumbnail, including the returned clipping polygon.
 * Ambiguous scenes and scans on white backgrounds deliberately keep the original image.
 */
export function findReceiptRegion(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): ReceiptRegion | undefined {
  // Bound all temporary arrays independently of caller input or photo metadata.
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width > 512 ||
    height > 512 ||
    pixels.length !== width * height * 4
  )
    return undefined;
  const count = width * height;
  const luminance = new Uint8Array(count);
  const histogram = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const offset = i * 4;
    // A transparent image has no dependable photographic background to remove.
    if (pixels[offset + 3] !== 255) return undefined;
    const value = (77 * pixels[offset] + 150 * pixels[offset + 1] + 29 * pixels[offset + 2]) >> 8;
    luminance[i] = value;
    histogram[value]++;
    sum += value;
  }

  let darkCount = 0;
  let darkSum = 0;
  let bestVariance = 0;
  let threshold = 0;
  let backgroundMean = 0;
  let paperMean = 0;
  let brightCount = 0;
  for (let value = 0; value < 255; value++) {
    darkCount += histogram[value];
    darkSum += histogram[value] * value;
    const lightCount = count - darkCount;
    if (!darkCount || !lightCount) continue;
    const darkMean = darkSum / darkCount;
    const lightMean = (sum - darkSum) / lightCount;
    const variance = darkCount * lightCount * (lightMean - darkMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = value;
      backgroundMean = darkMean;
      paperMean = lightMean;
      brightCount = lightCount;
    }
  }
  if (
    paperMean < 150 ||
    paperMean - backgroundMean < 60 ||
    brightCount < count * 0.1 ||
    brightCount > count * 0.95
  )
    return undefined;

  const remaining = new Uint8Array(count);
  for (let i = 0; i < count; i++) remaining[i] = luminance[i] > threshold ? 1 : 0;
  const queue = new Uint32Array(count);
  const candidates: Component[] = [];
  let rejectedArea = 0;
  for (let start = 0; start < count; start++) {
    if (!remaining[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    remaining[start] = 0;
    let left = width;
    let right = 0;
    let top = height;
    let bottom = 0;
    const visit = (neighbor: number) => {
      if (remaining[neighbor]) {
        remaining[neighbor] = 0;
        queue[tail++] = neighbor;
      }
    };
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
      if (x) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    if (tail < count * 0.08) continue;
    const boxArea = (right - left) * (bottom - top);
    if (
      boxArea < count * 0.12 ||
      boxArea > count * 0.94 ||
      right - left < 16 ||
      bottom - top < 16 ||
      tail / boxArea < 0.5
    ) {
      rejectedArea = Math.max(rejectedArea, tail);
      continue;
    }

    // Row extrema have the same convex hull as every component pixel, with small bounded storage.
    const rowLeft = new Uint16Array(height).fill(width);
    const rowRight = new Uint16Array(height);
    for (let i = 0; i < tail; i++) {
      const x = queue[i] % width;
      const y = Math.floor(queue[i] / width);
      rowLeft[y] = Math.min(rowLeft[y], x);
      rowRight[y] = Math.max(rowRight[y], x + 1);
    }
    const points: ReceiptPoint[] = [];
    for (let y = top; y < bottom; y++) {
      if (!rowRight[y]) continue;
      points.push(
        { x: rowLeft[y], y },
        { x: rowRight[y], y },
        { x: rowLeft[y], y: y + 1 },
        { x: rowRight[y], y: y + 1 },
      );
    }
    const polygon = convexHull(points);
    const area = polygonArea(polygon);
    if (area / boxArea < 0.68 || tail / area < 0.65) {
      rejectedArea = Math.max(rejectedArea, tail);
      continue;
    }
    candidates.push({ area: tail, left, right, top, bottom, rowLeft, rowRight });
  }
  candidates.sort((a, b) => b.area - a.area);
  const paper = candidates[0];
  if (!paper || rejectedArea >= paper.area * 0.5) return undefined;
  // Do not silently discard a second sheet or split a receipt across a dark horizontal stripe.
  if (candidates[1]?.area >= paper.area * 0.25) return undefined;

  const polygon = paperOutline(paper, width, height);
  if (!polygon) return undefined;
  const x = Math.max(0, paper.left - 2);
  const y = Math.max(0, paper.top - 2);
  return {
    x,
    y,
    width: Math.min(width, paper.right + 2) - x,
    height: Math.min(height, paper.bottom + 2) - y,
    polygon,
  };
}
