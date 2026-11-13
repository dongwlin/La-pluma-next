import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import {
  GAME_DAY_START_HOUR,
  gameTimeZoneForClientType,
  getGameDay,
  resolveGameZone
} from '../gameCalendar.ts';

/** 读取 IANA 时区在给定时刻的固定偏移；四个服务区都不使用夏令时。 */
function zoneOffsetHours(timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset'
  }).formatToParts(new Date('2026-01-15T00:00:00Z'));
  const name = parts.find(part => part.type === 'timeZoneName')?.value ?? '';
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) + Number(match[3]) / 60);
}

describe('game calendar', () => {
  it('moves to the next game day at 04:00 service time', () => {
    assert.equal(GAME_DAY_START_HOUR, 4);

    assert.deepEqual(
      getGameDay(new Date('2026-10-28T03:59:00+08:00'), 'Official'),
      { date: '2026-10-27', weekday: 2 }
    );
    assert.deepEqual(
      getGameDay(new Date('2026-10-28T04:00:00+08:00'), 'Official'),
      { date: '2026-10-28', weekday: 3 }
    );
  });

  it('starts a new week after Sunday midnight resolves into Monday at 04:00', () => {
    assert.deepEqual(
      getGameDay(new Date('2026-11-02T03:59:00+08:00'), 'Official'),
      { date: '2026-11-01', weekday: 0 }
    );
    assert.deepEqual(
      getGameDay(new Date('2026-11-02T04:00:00+08:00'), 'Official'),
      { date: '2026-11-02', weekday: 1 }
    );
  });

  it('applies each client service zone to the same instant', () => {
    const beforeBoundary = new Date('2026-10-28T03:59:00+08:00');
    assert.deepEqual(getGameDay(beforeBoundary, 'Official'), { date: '2026-10-27', weekday: 2 });
    assert.deepEqual(getGameDay(beforeBoundary, 'Txwy'), { date: '2026-10-27', weekday: 2 });
    assert.deepEqual(getGameDay(beforeBoundary, 'YoStarEN'), { date: '2026-10-27', weekday: 2 });
    assert.deepEqual(getGameDay(beforeBoundary, 'YoStarJP'), { date: '2026-10-28', weekday: 3 });
    assert.deepEqual(getGameDay(beforeBoundary, 'YoStarKR'), { date: '2026-10-28', weekday: 3 });

    const afterBoundary = new Date('2026-10-28T04:00:00+08:00');
    assert.deepEqual(getGameDay(afterBoundary, 'Official'), { date: '2026-10-28', weekday: 3 });
    // 同一瞬间国服已进入新游戏日，美服仍是前一日。
    assert.deepEqual(getGameDay(afterBoundary, 'YoStarEN'), { date: '2026-10-27', weekday: 2 });
  });

  it('keeps one instant on different game days across zones', () => {
    const instant = new Date('2026-10-28T10:00:00Z');
    assert.deepEqual(getGameDay(instant, 'Official'), { date: '2026-10-28', weekday: 3 });
    assert.deepEqual(getGameDay(instant, 'YoStarEN'), { date: '2026-10-27', weekday: 2 });
    assert.deepEqual(getGameDay(instant, 'YoStarJP'), { date: '2026-10-28', weekday: 3 });
  });

  it('normalizes unknown and mixed-case client types', () => {
    assert.equal(resolveGameZone(undefined).clientType, 'Official');
    assert.equal(resolveGameZone('').clientType, 'Official');
    assert.equal(resolveGameZone('unknown-client').clientType, 'Official');
    assert.equal(resolveGameZone('official').clientType, 'Official');
    assert.equal(resolveGameZone('txwy').clientType, 'txwy');
    assert.equal(resolveGameZone('Txwy').clientType, 'txwy');
    assert.equal(resolveGameZone('yostaren').clientType, 'YoStarEN');
    assert.equal(resolveGameZone(' yostarkr ').clientType, 'YoStarKR');
  });

  it('maps every client zone to an IANA name with the declared offset', () => {
    const expectations: Array<[string, string, number]> = [
      ['Official', 'Asia/Shanghai', 8],
      ['Bilibili', 'Asia/Shanghai', 8],
      ['txwy', 'Asia/Shanghai', 8],
      ['YoStarEN', 'Etc/GMT+7', -7],
      ['YoStarJP', 'Asia/Tokyo', 9],
      ['YoStarKR', 'Asia/Seoul', 9]
    ];
    for (const [clientType, timeZone, offset] of expectations) {
      assert.equal(gameTimeZoneForClientType(clientType), timeZone);
      assert.equal(resolveGameZone(clientType).utcOffsetHours, offset);
      assert.equal(zoneOffsetHours(timeZone), offset, `${timeZone} must keep its declared offset`);
    }
  });

  it('computes the same game day regardless of the host process time zone', () => {
    const calendarUrl = new URL('../gameCalendar.ts', import.meta.url).href;
    const stagesUrl = new URL('../notificationService.ts', import.meta.url).href;
    const script = `
import { getGameDay } from ${JSON.stringify(calendarUrl)};
import { getTodayOpenStages } from ${JSON.stringify(stagesUrl)};
const cases = [
  ['2026-10-28T03:59:00+08:00', 'Official'],
  ['2026-10-28T04:00:00+08:00', 'Official'],
  ['2026-10-28T10:00:00Z', 'YoStarEN'],
  ['2026-11-02T03:59:00+08:00', 'YoStarJP']
];
const overview = getTodayOpenStages({
  now: new Date('2026-10-28T04:00:00+08:00'),
  clientType: 'Official'
});
process.stdout.write(JSON.stringify({
  days: cases.map(([iso, clientType]) => getGameDay(new Date(iso), clientType)),
  open: overview.open.map(item => item.stage).sort(),
  closed: overview.closed.map(item => item.stage).sort()
}));
`;
    const run = (timeZone: string) => execFileSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, TZ: timeZone }, encoding: 'utf8' }
    );

    const expected = JSON.stringify({
      days: [
        { date: '2026-10-27', weekday: 2 },
        { date: '2026-10-28', weekday: 3 },
        { date: '2026-10-27', weekday: 2 },
        { date: '2026-11-02', weekday: 1 }
      ],
      // 周三游戏日：CE-6 关闭、SK-5 开放；宿主时区不得改变这一结论。
      open: ['CA-5', 'LS-6', 'PR-C', 'PR-D', 'SK-5'],
      closed: ['AP-5', 'CE-6', 'PR-A', 'PR-B']
    });
    const utc = run('UTC');
    assert.equal(utc, expected);
    assert.equal(run('America/New_York'), utc);
    assert.equal(run('Asia/Shanghai'), utc);
  });
});
