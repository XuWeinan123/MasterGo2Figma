export type Transform = [[number, number, number], [number, number, number]];

export function cloneTransform(transform: any): Transform {
    if (!transform || !Array.isArray(transform) || transform.length < 2) {
        return [[1, 0, 0], [0, 1, 0]];
    }
    const r0 = transform[0] || [1, 0, 0];
    const r1 = transform[1] || [0, 1, 0];
    return [
        [typeof r0[0] === "number" ? r0[0] : 1, typeof r0[1] === "number" ? r0[1] : 0, typeof r0[2] === "number" ? r0[2] : 0],
        [typeof r1[0] === "number" ? r1[0] : 0, typeof r1[1] === "number" ? r1[1] : 1, typeof r1[2] === "number" ? r1[2] : 0]
    ];
}
