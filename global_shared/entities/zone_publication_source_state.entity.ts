import { BaseEntity, Check, Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "zone_publication_source_state" })
@Check(`"id" = 1`)
@Check(
  "CHK_zone_publication_source_state_public_revision",
  `"publicRevision" >= 0`,
)
export class ZonePublicationSourceState extends BaseEntity {
  @PrimaryColumn({ type: "integer", default: 1 })
  id: number;

  @Column({ type: "bigint", default: 0 })
  revision: string;

  @Column({ type: "bigint", default: 0 })
  publicRevision: string;

  @Column({ type: "timestamp with time zone", default: () => "now()" })
  updatedAt: Date;
}
