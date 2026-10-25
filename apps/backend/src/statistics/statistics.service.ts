import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { DepartementsService } from '../departements/departements.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FindOptionsWhere,
  IsNull,
  MoreThanOrEqual,
  Not,
  Repository,
} from 'typeorm';
import { Statistic } from '@shared/entities/statistic.entity';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VigieauLogger } from '../logger/vigieau.logger';
import { MatomoStatisticsClient } from './matomo-statistics.client';
import { MatomoStatisticsRunService } from './matomo-statistics-run.service';

const MATOMO_FIELDS = [
  'visits',
  'restrictionsSearch',
  'arreteDownloads',
  'subscriptions',
  'profileRepartition',
  'departementRepartition',
  'regionRepartition',
] as const;

const completeStatisticWhere = (): FindOptionsWhere<Statistic> =>
  Object.fromEntries(MATOMO_FIELDS.map((field) => [field, Not(IsNull())]));

@Injectable()
export class StatisticsService {
  private readonly logger = new VigieauLogger('StatisticsService');

  private statistics: any = null;
  private readonly releaseDate: string = '2023-07-11';

  constructor(
    @InjectRepository(Statistic)
    private readonly statisticRepository: Repository<Statistic>,
    private readonly matomoClient: MatomoStatisticsClient,
    private readonly departementsService: DepartementsService,
    @Inject(forwardRef(() => SubscriptionsService))
    private readonly subscriptionsService: SubscriptionsService,
    private readonly matomoRun: MatomoStatisticsRunService,
  ) {}

  /**
   * Renvoie les statistiques stockées en mémoire.
   *
   * @returns {any} Les statistiques agrégées.
   */
  findAll() {
    return this.statistics;
  }

  /**
   * Charge les 30 derniers jours comportant des statistiques de frequentation.
   * Les données sont ensuite agrégées pour calculer les totaux.
   */
  async loadStatistics(): Promise<void> {
    const statistics = await this.statisticRepository.find({
      // Restriction snapshots share this table but contain no audience metrics.
      where: MATOMO_FIELDS.map((field) => ({
        date: MoreThanOrEqual(this.releaseDate),
        [field]: Not(IsNull()),
      })),
      order: {
        date: 'DESC',
      },
      take: 30,
    });

    this.statistics = this.aggregateStatistics(statistics.reverse());
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async refreshStatistics(): Promise<void> {
    await this.loadStatistics();
  }

  /**
   * Agrège les statistiques pour calculer les totaux par profil, département et région.
   *
   * @param statistics - Liste des statistiques à agréger.
   * @returns Les statistiques agrégées.
   */
  private aggregateStatistics(statistics: Statistic[]): any {
    const lastDataDate = statistics.at(-1)?.date || null;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const periodDays = statistics.length
      ? (Date.parse(lastDataDate) - Date.parse(statistics[0].date)) /
          (24 * 60 * 60 * 1000) +
        1
      : 0;
    const aggregated = {
      subscriptions: null as number | null,
      profileRepartition: {},
      departementRepartition: {},
      regionRepartition: {},
      statsByDay: [],
      period: statistics.length
        ? { from: statistics[0].date, to: lastDataDate }
        : null,
      lastDataDate,
      stale: !lastDataDate || lastDataDate < yesterday,
      partial:
        periodDays > statistics.length ||
        statistics.some((stat) =>
          MATOMO_FIELDS.some((field) => stat[field] == null),
        ),
    };

    for (const stat of statistics) {
      this.incrementRepartition(
        aggregated.profileRepartition,
        stat.profileRepartition,
      );
      this.incrementRepartition(
        aggregated.departementRepartition,
        stat.departementRepartition,
      );
      this.incrementRepartition(
        aggregated.regionRepartition,
        stat.regionRepartition,
      );
    }

    const subscriptions = statistics
      .map((stat) => stat.subscriptions)
      .filter((count) => count != null);
    if (subscriptions.length) {
      aggregated.subscriptions = subscriptions.reduce(
        (sum, count) => sum + count,
        0,
      );
    }

    aggregated.statsByDay = statistics.map((s) => ({
      date: s.date,
      visits: s.visits,
      arreteDownloads: s.arreteDownloads,
      restrictionsSearch: s.restrictionsSearch,
    }));

    return aggregated;
  }

  /**
   * Incrémente les valeurs d'une répartition avec celles d'une source.
   *
   * @param target - Répartition cible à incrémenter.
   * @param source - Répartition source contenant les valeurs à ajouter.
   */
  private incrementRepartition(
    target: Record<string, number>,
    source: Record<string, number>,
  ): void {
    for (const [key, value] of Object.entries(source || {})) {
      target[key] = (target[key] || 0) + value;
    }
  }

  /**
   * Tâche cron exécutée toutes les 3 heures pour calculer les statistiques
   * à partir des données collectées via les API Matomo.
   */
  @Cron(CronExpression.EVERY_3_HOURS)
  async computeStatistics(): Promise<void> {
    await this.matomoRun.run(this.matomoClient.configurationFingerprint(), () =>
      this.collectStatistics(),
    );
  }

  private async collectStatistics(): Promise<void> {
    this.logger.log('COMPUTE STATISTICS');
    const lastStat = await this.statisticRepository.findOne({
      where: {
        ...completeStatisticWhere(),
        date: MoreThanOrEqual(this.releaseDate),
      },
      order: { date: 'DESC' },
    });
    const lastStatDate = lastStat?.date
      ? new Date(lastStat?.date)
      : new Date(this.releaseDate);
    // Replay the last complete day and recover at most six following days per run.
    const lastRequestedDate = new Date(lastStatDate);
    lastRequestedDate.setUTCDate(lastRequestedDate.getUTCDate() + 6);
    const today = new Date(
      `${this.generateDateString(new Date())}T00:00:00.000Z`,
    );
    if (lastRequestedDate > today) lastRequestedDate.setTime(today.getTime());
    if (lastStatDate > lastRequestedDate) return;
    const matomoDate = `${this.generateDateString(lastStatDate)},${this.generateDateString(lastRequestedDate)}`;
    const [
      visitsByDay,
      oldVisitsByDay,
      restrictionsSearchsByDay,
      oldRestrictionsSearchsByDay,
      arreteDownloadsByDay,
      oldArreteDownloadsByDay,
      arreteCadreDownloadsByDay,
      oldArreteCadreDownloadsByDay,
      profileRepartitionByDay,
      oldProfileRepartitionByDay,
      departementRepartitionByDay,
      oldDepartementRepartitionByDay,
    ] = await Promise.all([
      this.matomoClient.getReport(
        'current',
        'VisitsSummary.getVisits',
        matomoDate,
      ),
      this.matomoClient.getReport(
        'legacy',
        'VisitsSummary.getVisits',
        matomoDate,
      ),
      this.matomoClient.getReport(
        'current',
        'Events.getActionFromCategoryId',
        matomoDate,
        '1',
      ),
      this.matomoClient.getReport(
        'legacy',
        'Events.getActionFromCategoryId',
        matomoDate,
        '1',
      ),
      this.matomoClient.getReport(
        'current',
        'Events.getActionFromCategoryId',
        matomoDate,
        '2',
      ),
      this.matomoClient.getReport(
        'legacy',
        'Events.getActionFromCategoryId',
        matomoDate,
        '2',
      ),
      this.matomoClient.getReport(
        'current',
        'Events.getActionFromCategoryId',
        matomoDate,
        '3',
      ),
      this.matomoClient.getReport(
        'legacy',
        'Events.getActionFromCategoryId',
        matomoDate,
        '3',
      ),
      this.matomoClient.getReport(
        'current',
        'Events.getNameFromActionId',
        matomoDate,
        '1',
      ),
      this.matomoClient.getReport(
        'legacy',
        'Events.getNameFromActionId',
        matomoDate,
        '1',
      ),
      this.matomoClient.getReport(
        'current',
        'Events.getNameFromActionId',
        matomoDate,
        '2',
      ),
      this.matomoClient.getReport(
        'legacy',
        'Events.getNameFromActionId',
        matomoDate,
        '2',
      ),
    ]);

    const statsToSave: any[] = [];
    for (
      const d = new Date(lastStatDate);
      d <= lastRequestedDate;
      d.setUTCDate(d.getUTCDate() + 1)
    ) {
      const stat: any = { date: new Date(d) };
      const day = this.generateDateString(d);

      stat.visits =
        (visitsByDay.data[day] ?? 0) + (oldVisitsByDay.data[day] ?? 0);

      let restrictionsSearch = restrictionsSearchsByDay.data[day];
      restrictionsSearch = restrictionsSearch?.find(
        (matomoEvent) => matomoEvent.label === 'CODE INSEE',
      )?.nb_events;
      let oldRestrictionsSearch = oldRestrictionsSearchsByDay.data[day];
      oldRestrictionsSearch = oldRestrictionsSearch?.find(
        (matomoEvent) => matomoEvent.label === 'CODE INSEE',
      )?.nb_events;
      stat.restrictionsSearch =
        (restrictionsSearch ? +restrictionsSearch : 0) +
        (oldRestrictionsSearch ? +oldRestrictionsSearch : 0);

      let arreteDownloads = 0;
      if (
        arreteDownloadsByDay.data[day] &&
        arreteDownloadsByDay.data[day][0]?.nb_events
      ) {
        arreteDownloads += +arreteDownloadsByDay.data[day][0].nb_events;
      }

      if (
        arreteCadreDownloadsByDay.data[day] &&
        arreteCadreDownloadsByDay.data[day][0]?.nb_events
      ) {
        arreteDownloads += +arreteCadreDownloadsByDay.data[day][0].nb_events;
      }

      let oldArreteDownloads = 0;
      if (
        oldArreteDownloadsByDay.data[day] &&
        oldArreteDownloadsByDay.data[day][0]?.nb_events
      ) {
        oldArreteDownloads += +oldArreteDownloadsByDay.data[day][0].nb_events;
      }

      if (
        oldArreteCadreDownloadsByDay.data[day] &&
        oldArreteCadreDownloadsByDay.data[day][0]?.nb_events
      ) {
        oldArreteDownloads +=
          +oldArreteCadreDownloadsByDay.data[day][0].nb_events;
      }

      stat.arreteDownloads = arreteDownloads + oldArreteDownloads;

      const profileRepartitionTmp = {
        particulier: 0,
        exploitation: 0,
        entreprise: 0,
        collectivite: 0,
      };
      if (profileRepartitionByDay.data[day]) {
        for (const profile in profileRepartitionTmp) {
          if (
            Object.prototype.hasOwnProperty.call(profileRepartitionTmp, profile)
          ) {
            const event = profileRepartitionByDay.data[day].find(
              (matomoEvent) => matomoEvent.label === profile,
            );
            profileRepartitionTmp[profile] += event ? +event.nb_events : 0;
          }
        }
      }

      if (oldProfileRepartitionByDay.data[day]) {
        for (const profile in profileRepartitionTmp) {
          if (
            Object.prototype.hasOwnProperty.call(profileRepartitionTmp, profile)
          ) {
            const event = oldProfileRepartitionByDay.data[day].find(
              (matomoEvent) => matomoEvent.label === profile,
            );
            profileRepartitionTmp[profile] += event ? +event.nb_events : 0;
          }
        }
      }

      stat.profileRepartition = profileRepartitionTmp;

      const departementRepartitionTmp = {};
      const regionRepartitionTmp = {};
      const departements = await this.departementsService.getAllLight();
      for (const code of departements.map((d) => d.code)) {
        departementRepartitionTmp[code] = 0;
      }

      for (const dep of departements) {
        regionRepartitionTmp[dep.region.code] = 0;
      }

      if (departementRepartitionByDay.data[day]) {
        for (const matomoEvent of departementRepartitionByDay.data[day]) {
          if (
            Object.prototype.hasOwnProperty.call(
              departementRepartitionTmp,
              matomoEvent.label,
            )
          ) {
            departementRepartitionTmp[matomoEvent.label] += Number(
              matomoEvent.nb_events,
            );
            regionRepartitionTmp[
              departements.find((d) => d.code === matomoEvent.label).region.code
            ] += +matomoEvent.nb_events;
          }
        }
      }

      if (oldDepartementRepartitionByDay.data[day]) {
        for (const matomoEvent of oldDepartementRepartitionByDay.data[day]) {
          if (
            Object.prototype.hasOwnProperty.call(
              departementRepartitionTmp,
              matomoEvent.label,
            )
          ) {
            departementRepartitionTmp[matomoEvent.label] += Number(
              matomoEvent.nb_events,
            );
            regionRepartitionTmp[
              departements.find((d) => d.code === matomoEvent.label).region.code
            ] += +matomoEvent.nb_events;
          }
        }
      }

      stat.departementRepartition = departementRepartitionTmp;
      stat.regionRepartition = regionRepartitionTmp;

      const subscriptions = await this.subscriptionsService.getAllLight();
      stat.subscriptions = subscriptions.filter(
        (s) => new Date(s.createdAt).toDateString() === d.toDateString(),
      ).length;

      statsToSave.push(stat);
    }

    if (statsToSave.length > 0) {
      await this.statisticRepository.upsert(statsToSave, ['date']);
    }

    await this.loadStatistics();
  }

  /**
   * Génère une chaîne de caractères représentant une date au format `YYYY-MM-DD`.
   *
   * @param date - La date à formater.
   * @returns Une chaîne de caractères formatée.
   */
  generateDateString(date) {
    return date.toISOString().split('T')[0];
  }
}
