import { BaseEntity, Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'zone_publication_commune' })
export class ZonePublicationCommune extends BaseEntity {
  @PrimaryColumn({ type: 'bigint' })
  publicationZoneId: string;

  @PrimaryColumn({ type: 'integer' })
  communeId: number;

  @Column({ type: 'uuid' })
  @Index()
  publicationId: string;

  @Column({ type: 'varchar', length: 6 })
  @Index()
  communeCode: string;
}
