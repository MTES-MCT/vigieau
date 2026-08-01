import { BaseEntity, Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'zone_publication_state' })
@Check(`"id" = 1`)
export class ZonePublicationState extends BaseEntity {
  @PrimaryColumn({ type: 'integer', default: 1 })
  id: number;

  @Column({ type: 'uuid', nullable: true })
  activePublicationId: string | null;

  @Column({ type: 'uuid', nullable: true })
  candidatePublicationId: string | null;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt: Date;
}
