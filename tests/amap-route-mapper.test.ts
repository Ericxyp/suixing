import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAmapDrivingRoute, mapAmapWalkingRoute } from '../server/mappers/amap-route-mapper';
import type { AmapDirectionResponse } from '../server/types/amap';

function drivingFixture(): AmapDirectionResponse {
  return {
    status: '1',
    info: 'OK',
    route: {
      paths: [
        {
          distance: '8500',
          duration: '1680',
          steps: [
            {
              instruction: '向东行驶',
              road: '淮海中路',
              polyline: '121.4630,31.2200;121.4700,31.2250',
            },
            {
              instruction: '到达目的地',
              road: '外滩',
              polyline: '121.4700,31.2250;121.4905,31.2397',
            },
          ],
        },
      ],
    },
  };
}

test('maps a driving route to taxi meters and minutes in original coordinate order', () => {
  const input = drivingFixture();
  const mapped = mapAmapDrivingRoute(input);

  assert.deepEqual(mapped, {
    transport: { mode: 'taxi', distanceMeters: 8500, durationMinutes: 28 },
    polyline: [
      { latitude: 31.22, longitude: 121.463 },
      { latitude: 31.225, longitude: 121.47 },
      { latitude: 31.2397, longitude: 121.4905 },
    ],
  });
  assert.equal(mapped?.polyline[0].longitude, 121.463);
  assert.equal(mapped?.polyline[0].latitude, 31.22);
  assert.deepEqual(input, drivingFixture());
  assert.equal(JSON.stringify(mapped).includes('status'), false);
  assert.equal(JSON.stringify(mapped).includes('OK'), false);
  assert.equal(JSON.stringify(mapped).includes('向东行驶'), false);
  assert.equal(JSON.stringify(mapped).includes('淮海中路'), false);
  assert.equal(JSON.stringify(mapped).includes('1680'), false);
  assert.equal(JSON.stringify(mapped).includes('instruction'), false);
  assert.equal(JSON.stringify(mapped).includes('road'), false);
});

test('maps a walking route to walk', () => {
  const input: AmapDirectionResponse = {
    status: '1',
    route: {
      paths: [
        {
          distance: 850,
          duration: 720,
          steps: [{ polyline: '121.4400,31.2110;121.4410,31.2120' }],
        },
      ],
    },
  };

  assert.deepEqual(mapAmapWalkingRoute(input), {
    transport: { mode: 'walk', distanceMeters: 850, durationMinutes: 12 },
    polyline: [
      { latitude: 31.211, longitude: 121.44 },
      { latitude: 31.212, longitude: 121.441 },
    ],
  });
});

test('merges step polylines and drops adjacent duplicate points', () => {
  const mapped = mapAmapDrivingRoute({
    status: '1',
    route: {
      paths: [
        {
          distance: '100',
          duration: '60',
          steps: [
            { polyline: '121.10,31.10;121.10,31.10;121.20,31.20' },
            { polyline: '121.20,31.20;121.30,31.30' },
            { polyline: 'not-a-point' },
            { polyline: '121.30,31.30;181.00,31.00;121.40,31.40' },
          ],
        },
      ],
    },
  });

  assert.deepEqual(mapped?.polyline, [
    { latitude: 31.1, longitude: 121.1 },
    { latitude: 31.2, longitude: 121.2 },
    { latitude: 31.3, longitude: 121.3 },
    { latitude: 31.4, longitude: 121.4 },
  ]);
});

test('returns null when the route or core fields are missing or invalid', () => {
  assert.equal(mapAmapDrivingRoute({ status: '0', info: 'SOME_UPSTREAM_MESSAGE', route: { paths: [] } }), null);
  assert.equal(mapAmapDrivingRoute({ status: '1' }), null);
  assert.equal(mapAmapDrivingRoute({ status: '1', route: { paths: [] } }), null);
  assert.equal(
    mapAmapWalkingRoute({
      status: '1',
      route: { paths: [{ duration: '60', steps: [{ polyline: '121.1,31.1' }] }] },
    }),
    null,
  );
  assert.equal(
    mapAmapWalkingRoute({
      status: '1',
      route: { paths: [{ distance: '100', steps: [{ polyline: '121.1,31.1' }] }] },
    }),
    null,
  );
  assert.equal(
    mapAmapDrivingRoute({
      status: '1',
      route: { paths: [{ distance: '100', duration: '60', steps: [{ polyline: 'invalid' }] }] },
    }),
    null,
  );
  assert.equal(
    mapAmapDrivingRoute({
      status: '1',
      route: { paths: [{ distance: '100', duration: '60', steps: [{ polyline: '121.1,91.0' }] }] },
    }),
    null,
  );
});
