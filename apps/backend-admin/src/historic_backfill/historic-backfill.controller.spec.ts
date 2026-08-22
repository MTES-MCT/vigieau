import { validate } from 'class-validator';
import {
  BuildHistoricBackfillShadowDto,
  FinalizeHistoricBackfillDto,
  HistoricBackfillController,
  HistoricBackfillRunParamsDto,
  PrepareHistoricBackfillDto,
} from './historic-backfill.controller';

describe('HistoricBackfillController', () => {
  const runId = 'b5c2e2be-51a1-4a9a-8ab5-5108de4d3062';

  beforeEach(() => {
    process.env.HISTORIC_BACKFILL_ENABLED = 'true';
  });

  afterAll(() => {
    delete process.env.HISTORIC_BACKFILL_ENABLED;
  });

  function createController() {
    const queue = {
      prepare: jest.fn().mockResolvedValue({ id: runId }),
      status: jest.fn().mockResolvedValue({ run: { id: runId } }),
      pause: jest.fn().mockResolvedValue(true),
      resume: jest.fn().mockResolvedValue(true),
    };
    const artifactQueue = {
      prepare: jest.fn().mockResolvedValue({ taskCount: 12 }),
    };
    const statisticsFinalizer = {
      buildShadow: jest.fn().mockResolvedValue({ departmentCount: 101 }),
      buildDepartmentShadow: jest
        .fn()
        .mockResolvedValue({ communeCount: 34_943 }),
      finalizeStatistics: jest.fn(async (_runId: string, apply: boolean) => ({
        mode: apply ? 'applied' : 'dry-run',
      })),
    };
    const mapFinalizer = {
      dryRun: jest.fn().mockResolvedValue({ mode: 'dry-run' }),
      apply: jest.fn().mockResolvedValue({ mode: 'applied' }),
    };

    return {
      controller: new HistoricBackfillController(
        queue as any,
        artifactQueue as any,
        statisticsFinalizer as any,
        mapFinalizer as any,
      ),
      queue,
      artifactQueue,
      statisticsFinalizer,
      mapFinalizer,
    };
  }

  it('delegates run lifecycle operations to their queues', async () => {
    const { controller, queue, artifactQueue } = createController();
    const input = {
      mapDateFrom: '2011-06-07',
      statisticDateFrom: '2024-04-29',
      dateThrough: '2026-08-16',
    };
    const params = { runId };

    await expect(controller.prepare(input)).resolves.toEqual({ id: runId });
    await expect(controller.status(params)).resolves.toEqual({
      run: { id: runId },
    });
    await expect(controller.pause(params)).resolves.toBe(true);
    await expect(controller.resume(params)).resolves.toBe(true);
    await expect(controller.prepareArtifacts(params)).resolves.toEqual({
      taskCount: 12,
    });

    expect(queue.prepare).toHaveBeenCalledWith(input);
    expect(queue.status).toHaveBeenCalledWith(runId);
    expect(queue.pause).toHaveBeenCalledWith(runId);
    expect(queue.resume).toHaveBeenCalledWith(runId);
    expect(artifactQueue.prepare).toHaveBeenCalledWith(runId);
  });

  it('delegates bulk and targeted shadow construction to the finalizer', async () => {
    const { controller, statisticsFinalizer } = createController();

    await expect(controller.buildShadow({ runId })).resolves.toEqual({
      departmentCount: 101,
    });
    await expect(
      controller.buildDepartmentShadow(
        { runId },
        { departementId: 77, departmentGeneration: '42' },
      ),
    ).resolves.toEqual({ communeCount: 34_943 });

    expect(statisticsFinalizer.buildShadow).toHaveBeenCalledWith(runId);
    expect(statisticsFinalizer.buildDepartmentShadow).toHaveBeenCalledWith({
      runId,
      departementId: 77,
      departmentGeneration: '42',
    });
  });

  it('keeps statistics and map finalization in dry-run mode by default', async () => {
    const { controller, statisticsFinalizer, mapFinalizer } =
      createController();

    await expect(controller.finalizeStatistics({ runId })).resolves.toEqual({
      mode: 'dry-run',
    });
    await expect(controller.finalizeMaps({ runId })).resolves.toEqual({
      mode: 'dry-run',
    });

    expect(statisticsFinalizer.finalizeStatistics).toHaveBeenCalledWith(
      runId,
      false,
    );
    expect(mapFinalizer.dryRun).toHaveBeenCalledWith(runId);
    expect(mapFinalizer.apply).not.toHaveBeenCalled();
  });

  it('applies statistics and map finalization only when explicitly requested', async () => {
    const { controller, statisticsFinalizer, mapFinalizer } =
      createController();

    await expect(
      controller.finalizeStatistics({ runId }, { apply: true }),
    ).resolves.toEqual({ mode: 'applied' });
    await expect(
      controller.finalizeMaps({ runId }, { apply: true }),
    ).resolves.toEqual({ mode: 'applied' });

    expect(statisticsFinalizer.finalizeStatistics).toHaveBeenCalledWith(
      runId,
      true,
    );
    expect(mapFinalizer.apply).toHaveBeenCalledWith(runId);
    expect(mapFinalizer.dryRun).not.toHaveBeenCalled();
  });

  it('validates civil dates, UUID params and the optional apply flag', async () => {
    const validPrepare = Object.assign(new PrepareHistoricBackfillDto(), {
      mapDateFrom: '2011-06-07',
      statisticDateFrom: '2024-04-29',
      dateThrough: '2026-08-16',
    });
    const timestampPrepare = Object.assign(new PrepareHistoricBackfillDto(), {
      ...validPrepare,
      mapDateFrom: '2011-06-07T00:00:00Z',
    });
    const invalidDatePrepare = Object.assign(new PrepareHistoricBackfillDto(), {
      ...validPrepare,
      dateThrough: '2026-02-30',
    });
    const validParams = Object.assign(new HistoricBackfillRunParamsDto(), {
      runId,
    });
    const invalidParams = Object.assign(new HistoricBackfillRunParamsDto(), {
      runId: 'not-a-uuid',
    });
    const validApply = Object.assign(new FinalizeHistoricBackfillDto(), {
      apply: false,
    });
    const invalidApply = Object.assign(new FinalizeHistoricBackfillDto(), {
      apply: 'true',
    });
    const validShadow = Object.assign(new BuildHistoricBackfillShadowDto(), {
      departementId: 77,
      departmentGeneration: '42',
    });
    const invalidShadow = Object.assign(new BuildHistoricBackfillShadowDto(), {
      departementId: 0,
      departmentGeneration: '-1',
    });

    await expect(validate(validPrepare)).resolves.toHaveLength(0);
    await expect(validate(timestampPrepare)).resolves.not.toHaveLength(0);
    await expect(validate(invalidDatePrepare)).resolves.not.toHaveLength(0);
    await expect(validate(validParams)).resolves.toHaveLength(0);
    await expect(validate(invalidParams)).resolves.not.toHaveLength(0);
    await expect(validate(validApply)).resolves.toHaveLength(0);
    await expect(validate(invalidApply)).resolves.not.toHaveLength(0);
    await expect(validate(validShadow)).resolves.toHaveLength(0);
    await expect(validate(invalidShadow)).resolves.not.toHaveLength(0);
  });

  it('keeps every mutating operation behind the kill switch', async () => {
    const { controller } = createController();
    process.env.HISTORIC_BACKFILL_ENABLED = 'false';

    expect(() => controller.pause({ runId })).toThrow(
      'Historic backfill is disabled by configuration',
    );
    await expect(controller.status({ runId })).resolves.toEqual({
      run: { id: runId },
    });
  });
});
