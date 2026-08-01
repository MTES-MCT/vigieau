import { BaseEntity, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'zone_publication_instance' })
export class ZonePublicationInstance extends BaseEntity {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  instanceId: string;

  @Column({ type: 'uuid', nullable: true })
  activePublicationId: string | null;

  @Column({ type: 'uuid', nullable: true })
  candidatePublicationId: string | null;

  @Column({ type: 'integer', nullable: true })
  zoneCount: number | null;

  @Column({ type: 'integer', nullable: true })
  communeLinkCount: number | null;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  heartbeatAt: Date;
}
