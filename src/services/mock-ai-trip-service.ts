import type { AiTripService, RequirementExtractionResult, TripPlanSuggestion, TripRequirementDraft } from '../domain/trip/ai';
import type { TripChangeOperation } from '../domain/trip/trip-change';

const destinations = ['上海', '杭州', '成都', '北京', '西安'];
const interests: Array<[string, string]> = [
  ['咖啡', '咖啡'], ['拍照', '拍照'], ['城市漫步', '城市漫步'], ['建筑', '建筑'],
  ['美食', '美食'], ['博物馆', '博物馆'], ['亲子', '亲子'], ['自然', '自然'], ['公园', '自然'],
];

function numberFromChinese(text: string): number | undefined {
  const match = text.match(/(\d+|一|二|三|四|五|六|七|八|九|十)\s*天/);
  if (!match) return undefined;
  const values: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Number(match[1]) || values[match[1]];
}

export class MockAiTripService implements AiTripService {
  async extractRequirements(input: string): Promise<RequirementExtractionResult> {
    const destination = destinations.find((city) => input.includes(city));
    const originMatch = input.match(/(?:从|^)(北京|上海|杭州|成都|西安)(?:出发)/);
    const durationDays = numberFromChinese(input);
    const peopleMatch = input.match(/(\d+)\s*人|([一二三四五六七八九十两])个?人/);
    const peopleValues: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const budgetMatch = input.match(/(?:预算\s*|¥)\s*(\d+(?:\.\d+)?)(?:\s*(万|元))?|(\d+(?:\.\d+)?)\s*元/);
    const budgetBase = budgetMatch?.[1] ?? budgetMatch?.[3];
    const totalBudget = budgetBase ? Number(budgetBase) * (budgetMatch?.[2] === '万' ? 10000 : 1) : undefined;
    const pace = /不想太累|轻松|慢慢逛|不想走太多路/.test(input) ? 'relaxed'
      : /特种兵|紧凑|多去几个地方/.test(input) ? 'packed' : 'balanced';
    const foundInterests = interests.filter(([keyword]) => input.includes(keyword)).map(([, label]) => label);
    const mustVisit = input.includes('西湖') ? ['西湖'] : undefined;
    const draft: TripRequirementDraft = {
      destination,
      origin: originMatch?.[1],
      durationDays,
      travelerCount: peopleMatch ? (Number(peopleMatch[1]) || peopleValues[peopleMatch[2]]) : undefined,
      totalBudget,
      pace,
      preferences: { interests: [...new Set(foundInterests)], ...(mustVisit ? { mustVisit } : {}) },
    };
    const missingRequiredFields = [
      !destination && { field: 'destination' as const, message: '请补充目的地。' },
      !durationDays && { field: 'durationDays' as const, message: '请补充日期或行程天数。' },
      !draft.travelerCount && { field: 'travelerCount' as const, message: '请补充同行人数。' },
      !totalBudget && { field: 'totalBudget' as const, message: '请补充总预算。' },
    ].filter(Boolean) as RequirementExtractionResult['missingRequiredFields'];
    return { draft, missingRequiredFields };
  }

  async suggestPlan(_requirements: TripRequirementDraft): Promise<TripPlanSuggestion> {
    return { days: [] };
  }

  async parseChangeIntent(_input: string, _tripId: string): Promise<TripChangeOperation[]> {
    return [];
  }
}

export const mockAiTripService: AiTripService = new MockAiTripService();
