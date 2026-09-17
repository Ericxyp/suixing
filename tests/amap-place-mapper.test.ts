import assert from 'node:assert/strict';
import test from 'node:test';
import { mapAmapPoiCategory, mapAmapPoiToPlace, parseAmapLocation } from '../server/mappers/amap-place-mapper';

test('maps AMap POI to the internal Place', () => {
  const input = { id: 'B001', name: '上海博物馆', address: '上海市黄浦区人民大道201号', location: '121.4748,31.2303', type: '风景名胜;博物馆' };
  assert.deepEqual(mapAmapPoiToPlace(input), { id: 'amap:B001', provider: 'amap', providerPlaceId: 'B001', name: '上海博物馆', address: '上海市黄浦区人民大道201号', longitude: 121.4748, latitude: 31.2303, category: 'attraction' });
  assert.deepEqual(input, { id: 'B001', name: '上海博物馆', address: '上海市黄浦区人民大道201号', location: '121.4748,31.2303', type: '风景名胜;博物馆' });
});
test('handles addresses and rejects invalid POIs', () => {
  assert.equal(mapAmapPoiToPlace({ id: 'a', name: 'n', location: '121,31' })?.address, '地址待补充');
  assert.equal(mapAmapPoiToPlace({ id: 'a', name: 'n', address: ['上海市', '黄浦区'], location: '121,31' })?.address, '上海市 黄浦区');
  for (const location of ['', 'invalid', '121.4', '121abc,31.2', '181,31', '121,91']) assert.equal(mapAmapPoiToPlace({ id: 'a', name: 'n', location }), null);
});
test('maps categories without leaking AMap category fields', () => {
  assert.equal(mapAmapPoiCategory({ type: '酒店' }), 'hotel');
  assert.equal(mapAmapPoiCategory({ type: '咖啡' }), 'cafe');
  assert.equal(mapAmapPoiCategory({ type: '餐厅' }), 'restaurant');
  assert.equal(mapAmapPoiCategory({ type: '购物中心' }), 'shopping');
  assert.equal(mapAmapPoiCategory({ type: '地铁站' }), 'transport');
  assert.equal(mapAmapPoiCategory({ type: '公园' }), 'attraction');
  assert.equal(mapAmapPoiCategory({ type: '未知' }), 'activity');
  assert.deepEqual(parseAmapLocation('121.4748,31.2303'), { longitude: 121.4748, latitude: 31.2303 });
});
