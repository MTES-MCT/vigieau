import { BaseEntity, Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'zone_publication_source_state' })
@Check(`"id" = 1`)
export class ZonePublicationSourceState extends BaseEntity {
  @PrimaryColumn({ type: 'integer', default: 1 })
  id: number;

  @Column({ type: 'bigint', default: 0 })
  revision: string;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt: Date;
}
