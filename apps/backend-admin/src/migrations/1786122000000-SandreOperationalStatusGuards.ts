import { MigrationInterface, QueryRunner } from 'typeorm';
import { SandreDisabledZoneReferenceGuard1785859200000 } from './1785859200000-SandreDisabledZoneReferenceGuard';

export class SandreOperationalStatusGuards1786122000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await new SandreDisabledZoneReferenceGuard1785859200000().install(
      queryRunner,
      'current',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [unsafeReferences] = await queryRunner.query(`
      SELECT
        EXISTS (
          SELECT 1
          FROM restriction reference
          JOIN arrete_restriction parent
            ON parent.id = reference."arreteRestrictionId"
          JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
          WHERE zone.disabled = true
            AND parent.statut <> 'abroge'
            AND parent.statut NOT IN ('a_venir', 'publie')
        )
        OR EXISTS (
          SELECT 1
          FROM arrete_cadre_zone_alerte reference
          JOIN arrete_cadre parent
            ON parent.id = reference."arreteCadreId"
          JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
          WHERE zone.disabled = true
            AND parent.statut <> 'abroge'
            AND parent.statut NOT IN ('a_venir', 'publie')
        )
        OR EXISTS (
          SELECT 1
          FROM arrete_cadre_zone_alerte_communes reference
          JOIN arrete_cadre parent
            ON parent.id = reference."arreteCadreId"
          JOIN zone_alerte zone ON zone.id = reference."zoneAlerteId"
          WHERE zone.disabled = true
            AND parent.statut <> 'abroge'
            AND parent.statut NOT IN ('a_venir', 'publie')
        ) AS "hasUnsafeDraftReferences"
    `);
    if (unsafeReferences?.hasUnsafeDraftReferences === true) {
      throw new Error(
        'Cannot restore legacy SANDRE guards while draft references target disabled zones; publish, abrogate, or reconcile those parents first',
      );
    }

    await new SandreDisabledZoneReferenceGuard1785859200000().install(
      queryRunner,
      'legacy',
    );
  }
}
