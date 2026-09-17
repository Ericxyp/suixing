import type { Place } from '../domain/trip/types';

export const mockPlaces: readonly Place[] = [
  { id: 'place-indigo-shanghai', provider: 'mock', providerPlaceId: 'mock-sh-001', name: '上海外滩英迪格酒店', address: '上海市黄浦区中山东二路585号', latitude: 31.2352, longitude: 121.4902, category: 'hotel' },
  { id: 'place-wukang-road', provider: 'mock', providerPlaceId: 'mock-sh-002', name: '武康路', address: '上海市徐汇区武康路', latitude: 31.2077, longitude: 121.4361, category: 'attraction' },
  { id: 'place-rac-coffee', provider: 'mock', providerPlaceId: 'mock-sh-003', name: 'RAC Coffee', address: '上海市徐汇区安福路322号', latitude: 31.2141, longitude: 121.4451, category: 'cafe' },
  { id: 'place-bund', provider: 'mock', providerPlaceId: 'mock-sh-004', name: '外滩', address: '上海市黄浦区中山东一路', latitude: 31.2401, longitude: 121.4908, category: 'attraction' },
  { id: 'place-xintiandi', provider: 'mock', providerPlaceId: 'mock-sh-005', name: '新天地', address: '上海市黄浦区兴业路123弄', latitude: 31.2204, longitude: 121.4754, category: 'shopping' },
  { id: 'place-shanghai-museum', provider: 'mock', providerPlaceId: 'mock-sh-006', name: '上海博物馆', address: '上海市黄浦区人民大道201号', latitude: 31.2303, longitude: 121.4748, category: 'attraction' },
  { id: 'place-peoples-square', provider: 'mock', providerPlaceId: 'mock-sh-007', name: '人民广场', address: '上海市黄浦区人民大道185号', latitude: 31.2306, longitude: 121.4737, category: 'attraction' },
  { id: 'place-jia-jia-tang-bao', provider: 'mock', providerPlaceId: 'mock-sh-008', name: '佳家汤包', address: '上海市黄浦区黄河路90号', latitude: 31.2324, longitude: 121.469, category: 'restaurant' },
  { id: 'place-nanjing-road', provider: 'mock', providerPlaceId: 'mock-sh-009', name: '南京东路', address: '上海市黄浦区南京东路', latitude: 31.2378, longitude: 121.4829, category: 'shopping' },
  { id: 'place-manner-coffee', provider: 'mock', providerPlaceId: 'mock-sh-010', name: 'Manner Coffee', address: '上海市黄浦区中山东二路', latitude: 31.2391, longitude: 121.4894, category: 'cafe' },
  { id: 'place-yuyuan', provider: 'mock', providerPlaceId: 'mock-sh-011', name: '豫园', address: '上海市黄浦区福佑路168号', latitude: 31.2272, longitude: 121.4928, category: 'attraction' },
  { id: 'place-hongqiao-station', provider: 'mock', providerPlaceId: 'mock-sh-012', name: '上海虹桥站', address: '上海市闵行区申贵路1500号', latitude: 31.1941, longitude: 121.3209, category: 'transport' },
];
