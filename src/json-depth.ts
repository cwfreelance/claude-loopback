/**
 * True if `value` nests objects/arrays more than `limit` levels deep. Iterative, so it can't
 * overflow the stack the way JSON.stringify or a recursive walk does on hostile input.
 */
export function deeperThan(value: unknown, limit: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, depth] = item;
    if (typeof node !== "object" || node === null) continue;
    if (depth > limit) return true;
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
  return false;
}
