import {
  BaseEntity,
  Column,
  Entity,
  Index,
  Polygon,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity({ name: 'zone_publication_zone' })
@Unique(['publicationId', 'sourceZoneId'])
@Unique(['id', 'publicationId'])
export class ZonePublicationZone extends BaseEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'uuid' })
  @Index()
  publicationId: string;

  @Column({ type: 'integer' })
  sourceZoneId: number;

  @Column({ type: 'integer' })
  @Index()
  departmentId: number;

  @Column({ type: 'varchar', length: 3 })
  departmentCode: string;

  @Column({ type: 'varchar', length: 3 })
  type: 'SOU' | 'SUP' | 'AEP';

  @Column({ type: 'geometry', select: false })
  geom: Polygon;

  @Column({ type: 'jsonb' })
  publicPayload: Record<string, unknown>;
}
