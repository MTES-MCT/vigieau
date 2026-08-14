import { BaseEntity, Column, Entity, PrimaryColumn } from "typeorm";
import { ZonePublicationAggregatePayload } from "../zone_publication_materialization";

@Entity({ name: "zone_publication_aggregate" })
export class ZonePublicationAggregate extends BaseEntity {
  @PrimaryColumn({ type: "uuid" })
  publicationId: string;

  @Column({ type: "jsonb" })
  payload: ZonePublicationAggregatePayload;

  @Column({ type: "timestamp with time zone", default: () => "now()" })
  createdAt: Date;
}
