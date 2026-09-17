import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AmapProviderError } from '../server/services/amap-http-client';
import type { PlaceSearchInput } from '../server/services/amap-place-service';
import {
  AmapTripPlaceResolver,
  classifyLandmarkCandidate,
  compareResolvedStops,
  DAY_FALLBACK_FIRST_DURATION_MINUTES,
  DAY_FALLBACK_FIRST_START,
  DAY_FALLBACK_REASON,
  DAY_FALLBACK_SECOND_DURATION_MINUTES,
  DAY_FALLBACK_SECOND_START,
  dayFallbackQueries,
  dayFallbackSearchLimit,
  landmarkSelectionPool,
  rotateClassicCityLabels,
  selectPlaceCandidate,
  TRIP_PLACE_SEARCH_CONCURRENCY,
  TRIP_PLACE_SEARCH_LIMIT,
  type PlaceSearchService,
} from '../server/services/trip-place-resolver';
import type {
  TripPlanPlaceCategory,
  TripPlanSuggestion,
} from '../server/services/trip-plan-generator';
import type { Place } from '../src/domain/trip/types';

function place(overrides: Partial<Place> & Pick<Place, 'id' | 'name'>): Place {
  return {
    provider: 'amap',
    providerPlaceId: overrides.id.replace(/^amap:/, ''),
    address: '上海市黄浦区示例路 1 号',
    latitude: 31.23,
    longitude: 121.47,
    category: 'attraction',
    ...overrides,
  };
}

function suggestion(
  name: string,
  category: TripPlanPlaceCategory = 'sight',
  query = name,
) {
  return {
    name,
    query,
    category,
    suggestedStartTime: '10:00',
    suggestedDurationMinutes: 90,
    reason: '符合轻松漫步偏好。',
  };
}

function planWithQueries(
  days: Array<Array<ReturnType<typeof suggestion>>>,
): TripPlanSuggestion {
  return {
    title: '上海 2 天游',
    summary: '以街区漫步和咖啡为主。',
    days: days.map((placeQueries, index) => ({
      dayNumber: index + 1,
      title: `第${index + 1}日`,
      summary: '减少跨城移动。',
      placeQueries,
    })),
  };
}

class FakePlaceSearch implements PlaceSearchService {
  calls: PlaceSearchInput[] = [];
  inFlight = 0;
  maxInFlight = 0;

  constructor(
    private readonly handler: (input: PlaceSearchInput) => Promise<Place[]>,
  ) {}

  async search(input: PlaceSearchInput): Promise<Place[]> {
    this.calls.push({
      query: input.query,
      city: input.city,
      limit: input.limit,
    });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      const places = await this.handler(input);
      return places;
    } finally {
      this.inFlight -= 1;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('uses destination as city and a fixed server-side search limit', async () => {
  const search = new FakePlaceSearch(async () => [
    place({ id: 'amap:B001', name: '武康路' }),
    place({ id: 'amap:B002', name: '安福路' }),
  ]);
  const resolver = new AmapTripPlaceResolver(search);
  const destination = ' 上海 ';
  const plan = planWithQueries([
    [suggestion('武康路'), suggestion('安福路')],
  ]);

  const resolved = await resolver.resolve({ destination, plan });

  assert.equal(search.calls.length, 2);
  for (const call of search.calls) {
    assert.equal(call.city, '上海');
    assert.equal(call.limit, TRIP_PLACE_SEARCH_LIMIT);
    assert.equal(call.limit, 5);
  }
  assert.equal(resolved.days[0].stops.length, 2);
  assert.equal(resolved.unresolved.length, 0);
  assert.equal(destination, ' 上海 ');
});

test('prefers an exact name match over a contains match and original order', async () => {
  const search = new FakePlaceSearch(async () => [
    place({ id: 'amap:FIRST', name: '武康路历史文化风貌区' }),
    place({ id: 'amap:EXACT', name: ' 武康路 ' }),
    place({ id: 'amap:OTHER', name: '武康大楼' }),
  ]);
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '上海',
    plan: planWithQueries([[suggestion('武康路')]]),
  });

  assert.equal(resolved.days[0].stops[0].place.id, 'amap:EXACT');
  assert.equal(resolved.days[0].stops[0].place.name, ' 武康路 ');
  assert.equal(resolved.unresolved.length, 0);
});

test('stable Place.id wins when Amap order changes or candidates otherwise tie', () => {
  const earlier = place({ id: 'amap:B2', name: '文昌阁' });
  const later = place({ id: 'amap:A1', name: '文昌阁' });
  const firstOrder = selectPlaceCandidate(
    [earlier, later],
    suggestion('文昌阁'),
    new Set(),
    { destination: '扬州' },
  );
  const reversed = selectPlaceCandidate(
    [later, earlier],
    suggestion('文昌阁'),
    new Set(),
    { destination: '扬州' },
  );
  assert.notEqual(firstOrder, 'NO_MATCH');
  assert.notEqual(firstOrder, 'DUPLICATE_MATCH');
  assert.notEqual(reversed, 'NO_MATCH');
  assert.notEqual(reversed, 'DUPLICATE_MATCH');
  assert.equal((firstOrder as Place).id, 'amap:A1');
  assert.equal((reversed as Place).id, 'amap:A1');
});

test('prefers destination city in address then same-day district before Place.id', () => {
  const otherCity = place({
    id: 'amap:A0',
    name: '文昌阁',
    address: '南京市秦淮区示例路 1 号',
  });
  const local = place({
    id: 'amap:Z9',
    name: '文昌阁',
    address: '扬州市广陵区文昌中路',
  });
  const selected = selectPlaceCandidate(
    [otherCity, local],
    suggestion('文昌阁'),
    new Set(),
    { destination: '扬州' },
  );
  assert.notEqual(selected, 'NO_MATCH');
  assert.notEqual(selected, 'DUPLICATE_MATCH');
  assert.equal((selected as Place).id, 'amap:Z9');
});

function selectedId(
  places: Place[],
  name: string,
  used: ReadonlySet<string> = new Set(),
): string {
  const snapshot = structuredClone(places);
  Object.freeze(places);
  for (const item of places) {
    Object.freeze(item);
  }
  const picked = selectPlaceCandidate(places, suggestion(name), used, { destination: '扬州' });
  assert.deepEqual(places, snapshot);
  assert.notEqual(picked, 'NO_MATCH');
  assert.notEqual(picked, 'DUPLICATE_MATCH');
  return (picked as Place).id;
}

test('prefers the main scenic area over pavilions when the query is a landmark name', () => {
  const pavilion = place({ id: 'amap:TING', name: '瘦西湖凉亭' });
  const scenic = place({ id: 'amap:SCENIC', name: '瘦西湖风景区' });
  const bridge = place({ id: 'amap:BRIDGE', name: '瘦西湖二十四桥' });
  const candidates = [pavilion, scenic, bridge];
  assert.equal(selectedId(candidates, '瘦西湖'), 'amap:SCENIC');
  assert.equal(selectedId([...candidates].reverse(), '瘦西湖'), 'amap:SCENIC');
  assert.equal(classifyLandmarkCandidate(scenic, suggestion('瘦西湖')), 'main');
  assert.equal(classifyLandmarkCandidate(pavilion, suggestion('瘦西湖')), 'sub');
  assert.equal(landmarkSelectionPool(candidates, suggestion('瘦西湖')).mode, 'MAIN_LANDMARK_MATCH');
});

test('allows an accessory POI when the query names that facility', () => {
  const pavilion = place({ id: 'amap:TING', name: '瘦西湖凉亭' });
  const scenic = place({ id: 'amap:SCENIC', name: '瘦西湖风景区' });
  assert.equal(selectedId([scenic, pavilion], '瘦西湖凉亭'), 'amap:TING');
});

test('rejects a bus stop named after a temple and keeps the main temple', () => {
  const bus = place({ id: 'amap:BUS', name: '大明寺(公交站)', category: 'transport' });
  const temple = place({ id: 'amap:TEMPLE', name: '大明寺' });
  assert.equal(selectedId([bus, temple], '大明寺'), 'amap:TEMPLE');
  assert.equal(
    selectPlaceCandidate([bus], suggestion('大明寺'), new Set(), { destination: '扬州' }),
    'NO_MATCH',
  );
});

test('rejects teahouses, restaurants and malls for sight queries', () => {
  const tea = place({ id: 'amap:TEA', name: '个园茶社', category: 'restaurant' });
  const mall = place({ id: 'amap:MALL', name: '个园商场', category: 'shopping' });
  const garden = place({ id: 'amap:GARDEN', name: '个园' });
  assert.equal(selectedId([tea, mall, garden], '个园'), 'amap:GARDEN');
  const dining = place({ id: 'amap:FOOD', name: '冶春园', category: 'restaurant' });
  assert.equal(
    selectPlaceCandidate([dining], suggestion('冶春园'), new Set(), { destination: '扬州' }),
    'NO_MATCH',
  );
  assert.equal(
    (
      selectPlaceCandidate(
        [dining],
        suggestion('冶春园茶社', 'food'),
        new Set(),
        { destination: '扬州' },
      ) as Place
    ).id,
    'amap:FOOD',
  );
});

test('museum intent rejects cafes and transit stops', () => {
  const cafe = place({ id: 'amap:CAFE', name: '博物馆咖啡', category: 'cafe' });
  const bus = place({ id: 'amap:BUS', name: '博物馆(公交站)', category: 'transport' });
  const museum = place({ id: 'amap:MUSEUM', name: '扬州博物馆' });
  assert.equal(
    (
      selectPlaceCandidate(
        [cafe, bus, museum],
        suggestion('扬州博物馆', 'other'),
        new Set(),
        { destination: '扬州' },
      ) as Place
    ).id,
    'amap:MUSEUM',
  );
});

test('prefers 故宫博物院 over gates, shops and visitor centers', () => {
  const gate = place({ id: 'amap:GATE', name: '故宫博物院午门' });
  const shop = place({ id: 'amap:SHOP', name: '故宫博物院文创店' });
  const center = place({ id: 'amap:CENTER', name: '故宫博物院游客中心' });
  const palace = place({ id: 'amap:PALACE', name: '故宫博物院' });
  assert.equal(selectedId([gate, shop, center, palace], '故宫博物院'), 'amap:PALACE');
});

test('allows a named gate when the query includes that accessory', () => {
  const gate = place({ id: 'amap:GATE', name: '故宫午门' });
  const palace = place({ id: 'amap:A-PALACE', name: '故宫博物院' });
  assert.equal(selectedId([palace, gate], '故宫午门'), 'amap:GATE');
});

test('does not substitute pavilions or visitor centers for a missing main landmark', () => {
  const pavilion = place({ id: 'amap:TING', name: '瘦西湖凉亭' });
  const scenic = place({ id: 'amap:SCENIC', name: '瘦西湖风景区' });
  const center = place({ id: 'amap:CENTER', name: '瘦西湖游客中心' });
  assert.equal(
    selectPlaceCandidate([pavilion, center], suggestion('瘦西湖'), new Set(), { destination: '扬州' }),
    'NO_MATCH',
  );
  assert.equal(
    selectPlaceCandidate(
      [pavilion, scenic, center],
      suggestion('瘦西湖'),
      new Set(['amap:SCENIC']),
      { destination: '扬州' },
    ),
    'NO_MATCH',
  );
  assert.equal(
    landmarkSelectionPool([pavilion], suggestion('瘦西湖')).mode,
    'SUB_PLACE_FALLBACK',
  );
  assert.deepEqual(landmarkSelectionPool([pavilion], suggestion('瘦西湖')).places, []);
});

test('uses mapped Place.category when names are equally fuzzy', async () => {
  const search = new FakePlaceSearch(async () => [
    place({
      id: 'amap:SHOP',
      name: '城隍庙商城',
      category: 'shopping',
    }),
    place({
      id: 'amap:FOOD',
      name: '城隍庙小吃',
      category: 'restaurant',
    }),
    place({
      id: 'amap:CAFE',
      name: '城隍庙咖啡',
      category: 'cafe',
    }),
  ]);
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '上海',
    plan: planWithQueries([[suggestion('城隍庙', 'food')]]),
  });

  assert.equal(resolved.days[0].stops[0].place.id, 'amap:FOOD');
  assert.equal(resolved.days[0].stops[0].place.category, 'restaurant');
  assert.equal(resolved.days[0].stops[0].category, 'food');
});

test('keeps the first Place.id in a day and marks later repeats as DUPLICATE_MATCH', async () => {
  const duplicate = place({ id: 'amap:SAME', name: '外滩' });
  const search = new FakePlaceSearch(async () => [duplicate]);
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '上海',
    plan: planWithQueries([[suggestion('外滩', 'sight', '外滩观景'), suggestion('外滩')]]),
  });

  assert.deepEqual(
    resolved.days[0].stops.map((stop) => stop.place.id),
    ['amap:SAME'],
  );
  assert.deepEqual(resolved.unresolved, [
    {
      dayNumber: 1,
      name: '外滩',
      query: '外滩',
      reason: 'DUPLICATE_MATCH',
    },
  ]);
});

test('does not reuse the same Place.id across days', async () => {
  const museum = place({ id: 'amap:MUSEUM', name: '上海博物馆' });
  const search = new FakePlaceSearch(async () => [museum]);
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '上海',
    plan: planWithQueries([
      [suggestion('上海博物馆')],
      [suggestion('上海博物馆')],
    ]),
  });

  assert.equal(resolved.days[0].stops[0].place.id, 'amap:MUSEUM');
  assert.deepEqual(resolved.days[1].stops, []);
  assert.deepEqual(resolved.unresolved, [
    {
      dayNumber: 2,
      name: '上海博物馆',
      query: '上海博物馆',
      reason: 'DUPLICATE_MATCH',
    },
  ]);
});

test('empty search results are NO_MATCH and do not block later places', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '武康路咖啡馆' || input.query === '上海武康路咖啡馆') {
      return [place({ id: 'amap:CAFE', name: '武康路咖啡馆', category: 'cafe' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '上海',
    plan: planWithQueries([
      [suggestion('不存在的店', 'coffee'), suggestion('武康路咖啡馆', 'coffee')],
    ]),
  });

  assert.equal(resolved.days[0].stops.length, 1);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:CAFE');
  assert.deepEqual(resolved.unresolved, [
    {
      dayNumber: 1,
      name: '不存在的店',
      query: '不存在的店',
      reason: 'NO_MATCH',
    },
  ]);
});

test('a single provider error becomes SEARCH_UNAVAILABLE and later queries continue', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '超时地点') {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com 500 key=leak');
    }
    if (input.query === '不可用地点') {
      throw new AmapProviderError('PROVIDER_UNAVAILABLE', 'ECONNRESET stack');
    }
    return [place({ id: 'amap:OK', name: '安福路' })];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '上海',
    plan: planWithQueries([
      [
        suggestion('超时地点'),
        suggestion('不可用地点'),
        suggestion('安福路'),
      ],
    ]),
  });

  assert.equal(resolved.days[0].stops.length, 1);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:OK');
  assert.deepEqual(
    resolved.unresolved.map((item) => item.reason),
    ['SEARCH_UNAVAILABLE', 'SEARCH_UNAVAILABLE'],
  );
  assert.equal(JSON.stringify(resolved).includes('amap.com'), false);
  assert.equal(JSON.stringify(resolved).includes('key='), false);
  assert.equal(JSON.stringify(resolved).includes('stack'), false);
});

test('invalid input throws INVALID_REQUEST without searching', async () => {
  const search = new FakePlaceSearch(async () => {
    throw new Error('should not search');
  });
  const resolver = new AmapTripPlaceResolver(search);
  const valid = planWithQueries([[suggestion('武康路'), suggestion('安福路')]]);

  const cases: Array<{ destination: string; plan: TripPlanSuggestion }> = [
    { destination: '   ', plan: valid },
    { destination: '上海', plan: { ...valid, days: [] } },
    {
      destination: '上海',
      plan: {
        ...valid,
        days: [{ ...valid.days[0], dayNumber: 2 }],
      },
    },
    {
      destination: '上海',
      plan: {
        ...valid,
        days: [{ ...valid.days[0], placeQueries: [] }],
      },
    },
  ];

  for (const input of cases) {
    await assert.rejects(
      () => resolver.resolve(input),
      (error: unknown) => {
        assert.ok(error instanceof AmapProviderError);
        assert.equal(error.code, 'INVALID_REQUEST');
        assert.equal(error.message, '行程地点解析请求无效，请调整后重试。');
        assert.equal(String(error.message).includes('amap'), false);
        return true;
      },
    );
  }
  assert.equal(search.calls.length, 0);
});

test('all unmatched queries return empty stops and a complete unresolved list', async () => {
  const search = new FakePlaceSearch(async () => []);
  const resolver = new AmapTripPlaceResolver(search);
  const plan = planWithQueries([
    [suggestion('甲'), suggestion('乙')],
    [suggestion('丙'), suggestion('丁')],
  ]);

  const resolved = await resolver.resolve({ destination: '上海', plan });

  assert.deepEqual(
    resolved.days.map((day) => day.stops),
    [[], []],
  );
  assert.deepEqual(
    resolved.unresolved.map((item) => ({ dayNumber: item.dayNumber, name: item.name, reason: item.reason })),
    [
      { dayNumber: 1, name: '甲', reason: 'NO_MATCH' },
      { dayNumber: 1, name: '乙', reason: 'NO_MATCH' },
      { dayNumber: 2, name: '丙', reason: 'NO_MATCH' },
      { dayNumber: 2, name: '丁', reason: 'NO_MATCH' },
    ],
  );
  assert.equal('id' in resolved, false);
});

test('caps concurrent searches and preserves draft order', async () => {
  const order: string[] = [];
  const search = new FakePlaceSearch(async (input) => {
    const wait = input.query === '慢查询' ? 40 : 5;
    await delay(wait);
    order.push(input.query);
    if (input.query === '慢查询' || input.query.endsWith('慢查询')) {
      return [];
    }
    return [place({ id: `amap:${input.query}`, name: input.query, category: 'cafe' })];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const plan = planWithQueries([
    [
      suggestion('慢查询', 'coffee'),
      suggestion('咖啡甲', 'coffee'),
      suggestion('咖啡乙', 'coffee'),
      suggestion('咖啡丙', 'coffee'),
    ],
  ]);

  const resolved = await resolver.resolve({ destination: '上海', plan });

  assert.ok(search.maxInFlight <= TRIP_PLACE_SEARCH_CONCURRENCY);
  assert.equal(search.maxInFlight, TRIP_PLACE_SEARCH_CONCURRENCY);
  assert.deepEqual(
    resolved.unresolved.map((item) => item.query),
    ['慢查询'],
  );
  assert.deepEqual(
    resolved.days[0].stops.map((stop) => stop.sourceQuery),
    ['咖啡甲', '咖啡乙', '咖啡丙'],
  );
  assert.ok(order.indexOf('慢查询') > order.indexOf('咖啡甲'));
});

test('does not mutate the plan, returned places, or search arguments', async () => {
  const rawPlaces = [
    place({ id: 'amap:B001', name: '武康路' }),
    place({ id: 'amap:B002', name: '安福路咖啡馆', category: 'cafe' }),
  ];
  const originalPlaces = structuredClone(rawPlaces);
  const searchInputSnapshots: PlaceSearchInput[] = [];
  const search = new FakePlaceSearch(async (input) => {
    searchInputSnapshots.push(input);
    Object.freeze(input);
    return rawPlaces;
  });
  const resolver = new AmapTripPlaceResolver(search);
  const plan = planWithQueries([
    [suggestion('武康路'), suggestion('安福路咖啡馆', 'coffee')],
  ]);
  const originalPlan = structuredClone(plan);
  Object.freeze(plan);
  Object.freeze(plan.days);
  plan.days.forEach((day) => {
    Object.freeze(day);
    Object.freeze(day.placeQueries);
    day.placeQueries.forEach((item) => Object.freeze(item));
  });

  const resolved = await resolver.resolve({ destination: '上海', plan });
  resolved.days[0].stops[0].place.name = '被改写';
  rawPlaces[0].name = '搜索结果被改写';

  assert.deepEqual(plan, originalPlan);
  assert.equal(originalPlaces[0].name, '武康路');
  assert.equal(resolved.days[0].stops[0].sourceQuery, '武康路');
  assert.equal(search.calls[0].limit, 5);
  assert.equal(searchInputSnapshots[0].limit, 5);
  assert.equal(searchInputSnapshots[0].city, '上海');
});

test('unknown search failures become a stable provider error without leaking details', async () => {
  const search = new FakePlaceSearch(async () => {
    throw new Error('TypeError at restapi.amap.com key=secret stack');
  });
  const resolver = new AmapTripPlaceResolver(search);

  await assert.rejects(
    () => resolver.resolve({
      destination: '上海',
      plan: planWithQueries([[suggestion('武康路')]]),
    }),
    (error: unknown) => {
      assert.ok(error instanceof AmapProviderError);
      assert.equal(error.code, 'PROVIDER_ERROR');
      assert.equal(error.message, '地点服务暂时不可用，请稍后重试。');
      assert.equal(String(error.message).includes('amap.com'), false);
      assert.equal(String(error.message).includes('secret'), false);
      return true;
    },
  );
});

test('resolver keeps landmark selection internals off public payloads', async () => {
  const search = new FakePlaceSearch(async () => [
    place({ id: 'amap:TING', name: '瘦西湖凉亭' }),
    place({ id: 'amap:SCENIC', name: '瘦西湖风景区' }),
  ]);
  const plan = planWithQueries([[suggestion('瘦西湖')]]);
  const planSnapshot = structuredClone(plan);
  const resolved = await new AmapTripPlaceResolver(search).resolve({
    destination: '扬州',
    plan,
  });
  assert.deepEqual(plan, planSnapshot);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:SCENIC');
  const serialized = JSON.stringify(resolved);
  assert.equal(serialized.includes('MAIN_LANDMARK_MATCH'), false);
  assert.equal(serialized.includes('SUB_PLACE_FALLBACK'), false);
  assert.equal(serialized.includes('LANDMARK_ACCESSORY'), false);
  const files = [
    'src/pages/TripDetailPage.tsx',
    'src/services/bff-client.ts',
    'server/routes/trip-generate.ts',
    'server/services/generation-logger.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    assert.equal(source.includes('MAIN_LANDMARK_MATCH'), false, file);
    assert.equal(source.includes('SUB_PLACE_FALLBACK'), false, file);
  }
});

test('tries name, normalized query and destination prefix fallbacks in order', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院') {
      return [place({ id: 'amap:GUGONG', name: '故宫博物院' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('故宫博物院', 'sight', '紫禁城下午场（网红店）')]]),
  });

  assert.deepEqual(
    search.calls.map((call) => call.query).slice(0, 2),
    ['紫禁城下午场（网红店）', '故宫博物院'],
  );
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:GUGONG');
  assert.equal(resolved.days[0].stops[0].place.name, '故宫博物院');
  assert.equal(resolved.days[0].stops[0].sourceQuery, '紫禁城下午场（网红店）');
  assert.equal(resolved.days[0].stops[0].resolutionSource, 'QUERY_FALLBACK_MATCH');
  assert.ok(
    search.calls.filter((call) => call.query === '北京景点' || call.query === '北京公园').length
      <= dayFallbackSearchLimit(1),
  );
  assert.equal(JSON.stringify(resolved).includes('day_fallback'), false);
});

test('does not invent a place from the AI name when fallbacks also miss', async () => {
  const search = new FakePlaceSearch(async () => []);
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('虚构咖啡馆', 'coffee', '虚构咖啡馆')]]),
  });
  assert.equal(resolved.days[0].stops.length, 0);
  assert.equal(resolved.unresolved[0]?.reason, 'NO_MATCH');
  assert.equal(resolved.days[0].stops.some((stop) => stop.place.name === '虚构咖啡馆' && stop.place.provider !== 'amap'), false);
});

test('reuses the same day fallback query and fills two morning and afternoon stops', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '北京咖啡馆') {
      return [
        place({ id: 'amap:CAFE1', name: '首家咖啡', category: 'cafe' }),
        place({ id: 'amap:CAFE2', name: '二家咖啡', category: 'cafe' }),
      ];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[
      suggestion('没有这家', 'coffee', '没有这家'),
      suggestion('也没有', 'coffee', '也没有'),
    ]]),
  });
  const fallbackCalls = search.calls.filter((call) => call.query === '北京咖啡馆');
  assert.equal(fallbackCalls.length, 1);
  assert.equal(resolved.days[0].stops.length, 2);
  assert.deepEqual(
    resolved.days[0].stops.map((stop) => stop.place.id),
    ['amap:CAFE1', 'amap:CAFE2'],
  );
  assert.equal(resolved.days[0].stops[0].suggestedStartTime, DAY_FALLBACK_FIRST_START);
  assert.equal(resolved.days[0].stops[0].suggestedDurationMinutes, DAY_FALLBACK_FIRST_DURATION_MINUTES);
  assert.equal(resolved.days[0].stops[1].suggestedStartTime, DAY_FALLBACK_SECOND_START);
  assert.equal(resolved.days[0].stops[1].suggestedDurationMinutes, DAY_FALLBACK_SECOND_DURATION_MINUTES);
  assert.equal(resolved.days[0].stops[0].reason, DAY_FALLBACK_REASON);
  assert.ok(resolved.days[0].stops.every((stop) => stop.resolutionSource === 'DAY_FALLBACK_MATCH'));
});

test('day fallback does not fill a sight day with restaurants or bus stops', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '北京景点') {
      return [
        place({ id: 'amap:BUS', name: '天安门(公交站)', category: 'transport' }),
        place({ id: 'amap:FOOD', name: '天安门餐厅', category: 'restaurant' }),
        place({ id: 'amap:PARKLOT', name: '天安门停车场', category: 'attraction' }),
      ];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('小众巷子甲'), suggestion('小众巷子乙')]]),
  });
  assert.equal(resolved.days[0].stops.length, 0);
  assert.ok(resolved.unresolved.every((item) => item.reason === 'NO_MATCH'));
  assert.equal(JSON.stringify(resolved).includes('公交站'), false);
});

test('day fallback runs at most missing-count-plus-one searches and needs two real places', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '北京景点') {
      return [
        place({ id: 'amap:TIANANMEN', name: '天安门广场' }),
        place({ id: 'amap:GUGONG', name: '故宫博物院' }),
      ];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('小众巷子甲'), suggestion('小众巷子乙')]]),
  });
  const dayFallbackCalls = search.calls.filter((call) => call.query === '北京景点' || call.query === '北京公园');
  assert.ok(dayFallbackCalls.length <= dayFallbackSearchLimit(2));
  assert.equal(search.calls.filter((call) => call.query === '北京景点').length, 1);
  assert.equal(resolved.days[0].stops.length, 2);
  assert.deepEqual(
    resolved.days[0].stops.map((stop) => [stop.place.id, stop.suggestedStartTime]),
    [['amap:GUGONG', '10:00'], ['amap:TIANANMEN', '14:30']],
  );
  assert.equal(resolved.unresolved.length, 2);
});

test('a single day-fallback place is discarded instead of creating an afternoon-only day', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '北京景点') {
      return [place({ id: 'amap:TIANANMEN', name: '天安门广场' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[
      { ...suggestion('小众巷子甲'), suggestedStartTime: '16:00' },
      { ...suggestion('小众巷子乙'), suggestedStartTime: '16:00' },
    ]]),
  });
  assert.ok(
    search.calls.filter((call) => call.query === '北京景点' || call.query === '北京公园').length
      <= dayFallbackSearchLimit(2),
  );
  assert.equal(resolved.days[0].stops.length, 0);
});

test('day fallback skips Place.ids used by earlier days and still fills later days', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '天安门') {
      return [place({ id: 'amap:TIANANMEN', name: '天安门广场' })];
    }
    if (input.query === '北京景点') {
      return [
        place({ id: 'amap:TIANANMEN', name: '天安门广场' }),
        place({ id: 'amap:GUGONG', name: '故宫博物院' }),
        place({ id: 'amap:YIHEYUAN', name: '颐和园' }),
        place({ id: 'amap:BEIHAI', name: '北海公园' }),
      ];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([
      [suggestion('天安门'), suggestion('天安门周边')],
      [suggestion('找不到甲'), suggestion('找不到乙')],
    ]),
  });
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:TIANANMEN');
  assert.equal(resolved.days[0].stops.length, 2);
  assert.equal(resolved.days[0].stops.some((stop) => stop.place.id === 'amap:BEIHAI'), true);
  assert.equal(resolved.days[1].stops.length, 2);
  assert.deepEqual(
    resolved.days[1].stops.map((stop) => stop.place.id),
    ['amap:GUGONG', 'amap:YIHEYUAN'],
  );
  assert.equal(resolved.days[1].stops[0].suggestedStartTime, '10:00');
  assert.equal(resolved.days[1].stops[1].suggestedStartTime, '14:30');
});

test('matched days do not enter day fallback', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院' || input.query === '景山公园') {
      return [place({ id: `amap:${input.query}`, name: input.query })];
    }
    return [place({ id: 'amap:SHOULD_NOT_USE', name: '不该回退' })];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('故宫博物院'), suggestion('景山公园')]]),
  });
  assert.equal(search.calls.some((call) => call.query === '北京景点' || call.query === '北京公园'), false);
  assert.equal(resolved.days[0].stops.length, 2);
  assert.ok(resolved.days[0].stops.every((stop) => stop.resolutionSource === 'PRIMARY_MATCH'));
});

test('provider errors do not trigger query or day fallbacks', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '超时地点' || input.query === '超时地点乙') {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com 500 key=leak');
    }
    return [place({ id: 'amap:SHOULD_NOT_USE', name: '不该回退' })];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('超时地点'), suggestion('超时地点乙')]]),
  });
  assert.deepEqual(
    search.calls.map((call) => call.query),
    ['超时地点', '超时地点乙'],
  );
  assert.equal(resolved.days[0].stops.length, 0);
  assert.deepEqual(
    resolved.unresolved.map((item) => item.reason),
    ['SEARCH_UNAVAILABLE', 'SEARCH_UNAVAILABLE'],
  );
  assert.equal(JSON.stringify(resolved).includes('amap.com'), false);
});

test('fills a second place when the day already has one AI match', async () => {
  const originalPlace = place({ id: 'amap:GUGONG', name: '故宫博物院' });
  const original = structuredClone(originalPlace);
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院') {
      return [originalPlace];
    }
    if (input.query === '北京咖啡馆') {
      return [place({ id: 'amap:CAFE', name: '王府井咖啡', category: 'cafe' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const morning = { ...suggestion('故宫博物院'), suggestedStartTime: '10:00', suggestedDurationMinutes: 150 };
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[morning, suggestion('没有这家', 'coffee', '没有这家')]]),
  });
  assert.deepEqual(
    search.calls.filter((call) => call.query === '北京咖啡馆' || call.query === '北京景点' || call.query === '北京公园')
      .map((call) => call.query),
    ['北京咖啡馆'],
  );
  assert.equal(search.calls.filter((call) => call.query === '北京咖啡馆' || call.query === '北京景点').length <= dayFallbackSearchLimit(1), true);
  assert.equal(resolved.days[0].stops.length, 2);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:GUGONG');
  assert.equal(resolved.days[0].stops[0].suggestedStartTime, '10:00');
  assert.equal(resolved.days[0].stops[0].suggestedDurationMinutes, 150);
  assert.equal(resolved.days[0].stops[0].resolutionSource, 'PRIMARY_MATCH');
  assert.equal(resolved.days[0].stops[1].place.id, 'amap:CAFE');
  assert.equal(resolved.days[0].stops[1].suggestedStartTime, '14:30');
  assert.equal(resolved.days[0].stops[1].suggestedDurationMinutes, DAY_FALLBACK_SECOND_DURATION_MINUTES);
  assert.equal(resolved.days[0].stops[1].reason, DAY_FALLBACK_REASON);
  assert.equal(resolved.days[0].stops[1].resolutionSource, 'DAY_FALLBACK_MATCH');
  assert.deepEqual(originalPlace, original);
});

test('afternoon AI stop keeps its time and sorts behind a morning fallback', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '国家博物馆') {
      return [place({ id: 'amap:MUSEUM', name: '国家博物馆' })];
    }
    if (input.query === '北京景点') {
      return [place({ id: 'amap:JINGSHAN', name: '景山公园' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[
      { ...suggestion('国家博物馆'), suggestedStartTime: '16:00', suggestedDurationMinutes: 80 },
      suggestion('找不到的巷子'),
    ]]),
  });
  assert.deepEqual(
    resolved.days[0].stops.map((stop) => [stop.place.id, stop.suggestedStartTime, stop.resolutionSource]),
    [
      ['amap:JINGSHAN', '10:00', 'DAY_FALLBACK_MATCH'],
      ['amap:MUSEUM', '16:00', 'PRIMARY_MATCH'],
    ],
  );
  assert.equal(resolved.days[0].stops[1].suggestedDurationMinutes, 80);
  const sorted = [...resolved.days[0].stops].sort(compareResolvedStops);
  assert.deepEqual(sorted.map((stop) => stop.place.id), ['amap:JINGSHAN', 'amap:MUSEUM']);
});

test('day fallback query order uses unmatched categories then city landmarks without repeats', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院') {
      return [place({ id: 'amap:GUGONG', name: '故宫博物院' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[
      suggestion('故宫博物院'),
      suggestion('没有咖啡', 'coffee', '没有咖啡'),
      suggestion('也没有餐厅', 'food', '也没有餐厅'),
    ]]),
  });
  assert.deepEqual(
    search.calls.filter((call) => (
      call.query === '北京咖啡馆'
      || call.query === '北京美食'
      || call.query === '北京景点'
      || call.query === '北京公园'
    )).map((call) => call.query),
    ['北京咖啡馆', '北京美食'],
  );
});

test('a partial day that cannot be filled stays short instead of inventing a place', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院') {
      return [place({ id: 'amap:GUGONG', name: '故宫博物院' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    plan: planWithQueries([[suggestion('故宫博物院'), suggestion('找不到乙')]]),
  });
  assert.ok(
    search.calls.filter((call) => call.query === '北京景点' || call.query === '北京公园').length
      <= dayFallbackSearchLimit(1),
  );
  assert.equal(resolved.days[0].stops.length, 1);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:GUGONG');
});

test('classic-route fallback rotates generic city queries by day number', async () => {
  assert.deepEqual(rotateClassicCityLabels(1).slice(0, 3), ['景点', '博物馆', '公园']);
  assert.deepEqual(rotateClassicCityLabels(2)[0], '博物馆');
  assert.deepEqual(rotateClassicCityLabels(3)[0], '公园');
  assert.deepEqual(
    dayFallbackQueries('北京', [], 4, { classicRoute: true, dayNumber: 2 }),
    ['北京博物馆', '北京公园', '北京历史街区', '北京城市漫步'],
  );
  const search = new FakePlaceSearch(async () => []);
  const resolver = new AmapTripPlaceResolver(search);
  const originalPlan = planWithQueries([
    [suggestion('找不到甲'), suggestion('找不到乙')],
    [suggestion('找不到丙'), suggestion('找不到丁')],
    [suggestion('找不到戊'), suggestion('找不到己')],
  ]);
  const frozen = structuredClone(originalPlan);
  await resolver.resolve({
    destination: '北京',
    hasExplicitTravelPreferences: false,
    plan: originalPlan,
  });
  const classic = search.calls
    .map((call) => call.query)
    .filter((query) => rotateClassicCityLabels(1).some((label) => query === `北京${label}`));
  assert.deepEqual(classic.slice(0, 4), ['北京景点', '北京博物馆', '北京公园', '北京历史街区']);
  assert.equal(classic.filter((query) => query === '北京博物馆').length, 1);
  assert.equal(classic.includes('北京城市漫步'), true);
  assert.equal(classic.slice(0, 4).length <= dayFallbackSearchLimit(2, true), true);
  assert.deepEqual(originalPlan, frozen);
});

test('classic-route fallback fills two distinct places and keeps an existing AI match', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院') {
      return [place({ id: 'amap:GUGONG', name: '故宫博物院' })];
    }
    if (input.query === '北京景点') {
      return [
        place({ id: 'amap:GUGONG', name: '故宫博物院' }),
        place({ id: 'amap:YIHEYUAN', name: '颐和园' }),
      ];
    }
    if (input.query === '北京博物馆') {
      return [place({ id: 'amap:NMC', name: '国家博物馆' })];
    }
    if (input.query === '北京公园') {
      return [
        place({ id: 'amap:BEIHAI', name: '北海公园' }),
        place({ id: 'amap:JINGSHAN', name: '景山公园' }),
      ];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    hasExplicitTravelPreferences: false,
    plan: planWithQueries([
      [
        { ...suggestion('故宫博物院'), suggestedStartTime: '10:00', suggestedDurationMinutes: 150 },
        suggestion('找不到乙'),
      ],
      [suggestion('找不到丙'), suggestion('找不到丁')],
    ]),
  });
  assert.equal(resolved.days[0].stops.length, 2);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:GUGONG');
  assert.equal(resolved.days[0].stops[0].suggestedStartTime, '10:00');
  assert.equal(resolved.days[0].stops[0].suggestedDurationMinutes, 150);
  assert.equal(resolved.days[0].stops[1].place.id, 'amap:YIHEYUAN');
  assert.equal(resolved.days[0].stops[1].suggestedStartTime, '14:30');
  assert.equal(resolved.days[1].stops.length, 2);
  assert.deepEqual(
    resolved.days[1].stops.map((stop) => [stop.place.id, stop.suggestedStartTime]),
    [['amap:NMC', '10:00'], ['amap:BEIHAI', '14:30']],
  );
  assert.equal(new Set(resolved.days.flatMap((day) => day.stops.map((stop) => stop.place.id))).size, 4);
});

test('explicit preferences still prefer unmatched category queries over classic labels', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '故宫博物院') {
      return [place({ id: 'amap:GUGONG', name: '故宫博物院' })];
    }
    if (input.query === '北京咖啡馆') {
      return [place({ id: 'amap:CAFE', name: '王府井咖啡', category: 'cafe' })];
    }
    if (input.query === '北京景点' || input.query === '北京博物馆') {
      return [place({ id: 'amap:SHOULD_NOT_USE', name: '不该覆盖偏好' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    hasExplicitTravelPreferences: true,
    plan: planWithQueries([[suggestion('故宫博物院'), suggestion('没有这家', 'coffee', '没有这家')]]),
  });
  assert.equal(search.calls.some((call) => call.query === '北京咖啡馆'), true);
  assert.equal(search.calls.some((call) => call.query === '北京景点' || call.query === '北京博物馆'), false);
  assert.equal(resolved.days[0].stops[1].place.id, 'amap:CAFE');
});

test('classic-route fallback still fills after one provider error on the same day', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '超时地点') {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com 500 key=leak');
    }
    if (input.query === '故宫博物院') {
      return [place({ id: 'amap:GUGONG', name: '故宫博物院' })];
    }
    if (input.query === '北京景点') {
      return [place({ id: 'amap:YIHEYUAN', name: '颐和园' })];
    }
    return [];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    hasExplicitTravelPreferences: false,
    plan: planWithQueries([[suggestion('故宫博物院'), suggestion('超时地点')]]),
  });
  assert.equal(resolved.days[0].stops.length, 2);
  assert.equal(resolved.days[0].stops[0].place.id, 'amap:GUGONG');
  assert.equal(resolved.days[0].stops[1].place.id, 'amap:YIHEYUAN');
  assert.equal(search.calls.some((call) => call.query === '北京景点'), true);
});

test('classic-route provider errors still skip default fallback', async () => {
  const search = new FakePlaceSearch(async (input) => {
    if (input.query === '超时地点' || input.query === '超时地点乙') {
      throw new AmapProviderError('PROVIDER_ERROR', 'restapi.amap.com 500 key=leak');
    }
    return [place({ id: 'amap:SHOULD_NOT_USE', name: '不该回退' })];
  });
  const resolver = new AmapTripPlaceResolver(search);
  const resolved = await resolver.resolve({
    destination: '北京',
    hasExplicitTravelPreferences: false,
    plan: planWithQueries([[suggestion('超时地点'), suggestion('超时地点乙')]]),
  });
  assert.equal(search.calls.some((call) => call.query === '北京景点'), false);
  assert.equal(resolved.days[0].stops.length, 0);
});

