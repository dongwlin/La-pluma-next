export interface FixturePoint {
  x: number;
  y: number;
}

export type FixtureLabel = 'native' | 'mixed';

export const fixtureOrigin: FixturePoint = { x: 0, y: 0 };

export function sumCoordinates(point: FixturePoint): number {
  return point.x + point.y;
}

export function describeFixture(label: FixtureLabel): string {
  return `type stripping fixture: ${label}`;
}
