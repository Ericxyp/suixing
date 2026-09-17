import type { GeoPoint, TransportSegment, Trip, TripPlace } from '../domain/trip/types';

const tripId = 'trip-shanghai-2026-national-day';
const dayIds = ['trip-day-shanghai-1', 'trip-day-shanghai-2', 'trip-day-shanghai-3'] as const;

function segment(mode: TransportSegment['mode'], durationMinutes: number, distanceMeters: number, description: string): TransportSegment {
  return { mode, durationMinutes, distanceMeters, description };
}

function place(
  id: string,
  dayId: string,
  order: number,
  placeId: string,
  placeName: string,
  type: TripPlace['type'],
  startTime: string,
  durationMinutes: number,
  description: string,
  estimatedCost: number,
  transportToNext?: TransportSegment,
): TripPlace {
  return { id, dayId, order, placeId, placeName, type, startTime, durationMinutes, description, estimatedCost, transportToNext };
}

// 仅用于地图展示的 Mock 路线形状，并非真实导航路径。
const line = (
  ...points: ReadonlyArray<readonly [latitude: number, longitude: number]>
): GeoPoint[] => points.map(([latitude, longitude]) => ({ latitude, longitude }));

export const mockShanghaiTrip: Trip = {
  id: tripId,
  userId: 'user-demo-001',
  title: '上海 · 3天2晚',
  destination: '上海',
  origin: '北京',
  startDate: '2026-10-01',
  endDate: '2026-10-03',
  travelerCount: 2,
  totalBudget: 3820,
  currency: 'CNY',
  pace: 'relaxed',
  preferences: {
    interests: ['咖啡', '拍照', '城市漫步', '建筑', '美食'],
    accommodation: ['靠近地铁', '江景'],
  },
  status: 'PLANNING',
  days: [
    {
      id: dayIds[0], tripId, dayNumber: 1, date: '2026-10-01', title: '梧桐街区与江畔夜景', summary: '从武康路慢慢逛到外滩，傍晚在新天地用餐。',
      places: [
        place('tp-d1-hotel', dayIds[0], 1, 'place-indigo-shanghai', '上海外滩英迪格酒店', 'hotel', '09:00', 60, '寄存行李后，从酒店开始第一天的轻松漫步。', 0, segment('taxi', 28, 8500, '前往武康路')),
        place('tp-d1-wukang', dayIds[0], 2, 'place-wukang-road', '武康路', 'attraction', '10:30', 90, '漫步梧桐树下的历史街区，适合拍照。', 0, segment('walk', 12, 850, '步行前往咖啡店')),
        place('tp-d1-rac', dayIds[0], 3, 'place-rac-coffee', 'RAC Coffee', 'cafe', '12:20', 80, '咖啡和简餐，安排充足的休息时间。', 120, segment('metro', 28, 7600, '乘地铁前往外滩')),
        place('tp-d1-bund', dayIds[0], 4, 'place-bund', '外滩', 'attraction', '15:00', 150, '沿江欣赏万国建筑群，等待日落。', 0, segment('taxi', 18, 4700, '前往新天地')),
        place('tp-d1-xintiandi', dayIds[0], 5, 'place-xintiandi', '新天地', 'shopping', '18:30', 120, '石库门街区晚餐与自由活动。', 260),
      ],
    },
    {
      id: dayIds[1], tripId, dayNumber: 2, date: '2026-10-02', title: '梧桐街区与城市中心', summary: '上午短暂漫步武康路，再到人民广场和南京东路，节奏轻松。',
      places: [
        place('tp-d2-hotel', dayIds[1], 1, 'place-indigo-shanghai', '上海外滩英迪格酒店', 'hotel', '09:30', 30, '早餐后从酒店出发。', 0, segment('taxi', 43, 8500, '前往武康路')),
        place('tp-d2-wukang', dayIds[1], 2, 'place-wukang-road', '武康路', 'attraction', '10:30', 90, '漫步梧桐树下的历史街区，适合拍照。', 0, segment('metro', 24, 6700, '前往人民广场')),
        place('tp-d2-square', dayIds[1], 3, 'place-peoples-square', '人民广场', 'attraction', '12:30', 35, '在市中心广场短暂休息。', 0, segment('walk', 8, 600, '步行至午餐地点')),
        place('tp-d2-lunch', dayIds[1], 4, 'place-jia-jia-tang-bao', '佳家汤包', 'restaurant', '13:20', 60, '品尝本地小笼包，避开高峰时段。', 110, segment('metro', 18, 3600, '前往南京东路')),
        place('tp-d2-nanjing', dayIds[1], 5, 'place-nanjing-road', '南京东路', 'shopping', '15:00', 120, '自由逛街，可随时提前返回酒店。', 200),
      ],
    },
    {
      id: dayIds[2], tripId, dayNumber: 3, date: '2026-10-03', title: '咖啡与返程', summary: '上午轻松逛豫园，午后前往虹桥站返程。',
      places: [
        place('tp-d3-hotel', dayIds[2], 1, 'place-indigo-shanghai', '上海外滩英迪格酒店', 'hotel', '09:00', 30, '退房并寄存行李。', 0, segment('walk', 6, 450, '步行至早餐咖啡')),
        place('tp-d3-coffee', dayIds[2], 2, 'place-manner-coffee', 'Manner Coffee', 'cafe', '09:40', 50, '江边咖啡和轻早餐。', 70, segment('taxi', 16, 3900, '前往豫园')),
        place('tp-d3-yuyuan', dayIds[2], 3, 'place-yuyuan', '豫园', 'attraction', '11:00', 100, '返程前的轻量园林游览。', 40, segment('metro', 52, 21000, '前往上海虹桥站')),
        place('tp-d3-station', dayIds[2], 4, 'place-hongqiao-station', '上海虹桥站', 'transport', '13:30', 60, '预留充足候车时间，搭乘返京高铁。', 0),
      ],
    },
  ],
  routes: [
    { id: 'route-d1-1', dayId: dayIds[0], fromTripPlaceId: 'tp-d1-hotel', toTripPlaceId: 'tp-d1-wukang', transport: segment('taxi', 28, 8500, '前往武康路'), polyline: line([31.2352, 121.4902], [31.2290, 121.4760], [31.2190, 121.4590], [31.2110, 121.4440], [31.2077, 121.4361]) },
    { id: 'route-d1-2', dayId: dayIds[0], fromTripPlaceId: 'tp-d1-wukang', toTripPlaceId: 'tp-d1-rac', transport: segment('walk', 12, 850, '步行前往咖啡店'), polyline: line([31.2077, 121.4361], [31.2105, 121.4394], [31.2122, 121.4420], [31.2141, 121.4451]) },
    { id: 'route-d1-3', dayId: dayIds[0], fromTripPlaceId: 'tp-d1-rac', toTripPlaceId: 'tp-d1-bund', transport: segment('metro', 28, 7600, '乘地铁前往外滩'), polyline: line([31.2141, 121.4451], [31.2185, 121.4530], [31.2250, 121.4700], [31.2340, 121.4840], [31.2401, 121.4908]) },
    { id: 'route-d1-4', dayId: dayIds[0], fromTripPlaceId: 'tp-d1-bund', toTripPlaceId: 'tp-d1-xintiandi', transport: segment('taxi', 18, 4700, '前往新天地'), polyline: line([31.2401, 121.4908], [31.2350, 121.4860], [31.2290, 121.4810], [31.2230, 121.4770], [31.2204, 121.4754]) },
    { id: 'route-d2-1', dayId: dayIds[1], fromTripPlaceId: 'tp-d2-hotel', toTripPlaceId: 'tp-d2-wukang', transport: segment('taxi', 43, 8500, '前往武康路'), polyline: line([31.2352, 121.4902], [31.2290, 121.4760], [31.2190, 121.4590], [31.2110, 121.4440], [31.2077, 121.4361]) },
    { id: 'route-d2-2', dayId: dayIds[1], fromTripPlaceId: 'tp-d2-wukang', toTripPlaceId: 'tp-d2-square', transport: segment('metro', 24, 6700, '前往人民广场'), polyline: line([31.2077, 121.4361], [31.2120, 121.4450], [31.2180, 121.4560], [31.2250, 121.4670], [31.2306, 121.4737]) },
    { id: 'route-d2-3', dayId: dayIds[1], fromTripPlaceId: 'tp-d2-square', toTripPlaceId: 'tp-d2-lunch', transport: segment('walk', 8, 600, '步行至午餐地点'), polyline: line([31.2306, 121.4737], [31.2310, 121.4720], [31.2320, 121.4700], [31.2324, 121.4690]) },
    { id: 'route-d2-4', dayId: dayIds[1], fromTripPlaceId: 'tp-d2-lunch', toTripPlaceId: 'tp-d2-nanjing', transport: segment('metro', 18, 3600, '前往南京东路'), polyline: line([31.2324, 121.4690], [31.2335, 121.4730], [31.2350, 121.4780], [31.2378, 121.4829]) },
    { id: 'route-d3-1', dayId: dayIds[2], fromTripPlaceId: 'tp-d3-hotel', toTripPlaceId: 'tp-d3-coffee', transport: segment('walk', 6, 450, '步行至早餐咖啡'), polyline: line([31.2352, 121.4902], [31.2370, 121.4900], [31.2391, 121.4894]) },
    { id: 'route-d3-2', dayId: dayIds[2], fromTripPlaceId: 'tp-d3-coffee', toTripPlaceId: 'tp-d3-yuyuan', transport: segment('taxi', 16, 3900, '前往豫园'), polyline: line([31.2391, 121.4894], [31.2350, 121.4910], [31.2310, 121.4920], [31.2272, 121.4928]) },
    { id: 'route-d3-3', dayId: dayIds[2], fromTripPlaceId: 'tp-d3-yuyuan', toTripPlaceId: 'tp-d3-station', transport: segment('metro', 52, 21000, '前往上海虹桥站'), polyline: line([31.2272, 121.4928], [31.2240, 121.4750], [31.2180, 121.4400], [31.2100, 121.3900], [31.1980, 121.3400], [31.1941, 121.3209]) },
  ],
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z',
};

export const mockTrips: readonly Trip[] = [
  mockShanghaiTrip,
  {
    id: 'trip-hangzhou-autumn',
    userId: 'user-demo-001',
    title: '杭州 · 周末慢游',
    destination: '杭州',
    origin: '上海',
    startDate: '2026-10-17',
    endDate: '2026-10-18',
    travelerCount: 2,
    totalBudget: 2600,
    currency: 'CNY',
    pace: 'relaxed',
    preferences: { interests: ['湖景', '茶馆', '美食'] },
    status: 'READY',
    days: [],
    routes: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  },
  {
    id: 'trip-chengdu-spring',
    userId: 'user-demo-001',
    title: '成都 · 春日三天',
    destination: '成都',
    startDate: '2026-04-03',
    endDate: '2026-04-05',
    travelerCount: 2,
    totalBudget: 3400,
    currency: 'CNY',
    pace: 'balanced',
    preferences: { interests: ['川菜', '街区', '熊猫'] },
    status: 'COMPLETED',
    days: [],
    routes: [],
    createdAt: '2026-03-02T00:00:00.000Z',
    updatedAt: '2026-04-05T00:00:00.000Z',
  },
];
