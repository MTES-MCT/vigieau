import { DataSource, QueryRunner } from 'typeorm';
import { prepareArbitratedRow } from './patch-arbitrated-history';

const url = process.env.REPAIR_CERTIFIED_HISTORY_POSTGRES_URL;
(url ? describe : describe.skip)(
  'arbitrated historical row preparation',
  () => {
    let db: DataSource;
    let r: QueryRunner;
    const date = '2026-07-13';
    const old = { AEP: null, SOU: null, SUP: null };
    const after = { ...old, AEP: 'alerte' };
    const patch = {
      communes: [{ code: '12231', date, before: old, after }],
      departments: [],
      statistics: [],
    };
    beforeAll(async () => {
      db = await new DataSource({ type: 'postgres', url }).initialize();
      r = db.createQueryRunner();
      await r.connect();
      await r.query(`
      CREATE TEMP TABLE commune (id integer PRIMARY KEY,code text UNIQUE);
      CREATE TEMP TABLE statistic_commune (id integer PRIMARY KEY, "communeId" integer, restrictions jsonb, "restrictionsByMonth" jsonb);
      INSERT INTO commune VALUES (101,'12231');
      INSERT INTO statistic_commune
      SELECT 1,101,jsonb_agg(jsonb_build_object('date',date::date::text,'AEP',NULL,'SUP',NULL,'SOU',NULL) ORDER BY date),
        '[{"date":"2026-06","ponderation":5},{"date":"2026-07","ponderation":0},{"date":"2026-08","ponderation":0}]'::jsonb
      FROM generate_series('2026-07-10'::date,'2026-09-01'::date,interval '1 day') date;
    `);
    });
    afterAll(async () => {
      await r.release();
      await db.destroy();
    });
    it('limits edits to the arbitrated days and recalculates the monthly weight', async () => {
      const image = await prepareArbitratedRow(
        r,
        JSON.stringify(patch),
        'communes',
        '12231',
      );
      const expected = JSON.parse(image.before);
      expected.find((row: { date: string }) => row.date === date).AEP =
        'alerte';
      expect(JSON.parse(image.after)).toEqual(expected);
      expect(JSON.parse(image.monthsAfter)).toEqual([
        { date: '2026-06', ponderation: 5 },
        { date: '2026-07', ponderation: 2 },
        { date: '2026-08', ponderation: 0 },
      ]);
      const invalid = {
        communes: [
          { ...patch.communes[0], before: { ...old, AEP: 'vigilance' } },
        ],
      };
      await expect(
        prepareArbitratedRow(r, JSON.stringify(invalid), 'communes', '12231'),
      ).rejects.toThrow('Preimage');
      await r.query(
        'UPDATE statistic_commune SET restrictions=$1,"restrictionsByMonth"=$2',
        [image.after, image.monthsAfter],
      );
      const replay = await prepareArbitratedRow(
        r,
        JSON.stringify(patch),
        'communes',
        '12231',
      );
      expect(replay.after).toBe(replay.before);
      expect(replay.monthsAfter).toBe(replay.monthsBefore);
    });
  },
);
