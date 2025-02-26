import {forwardRef, Module} from '@nestjs/common';
import {ArreteRestrictionService} from './arrete_restriction.service';
import {ArreteRestrictionController} from './arrete_restriction.controller';
import {TypeOrmModule} from '@nestjs/typeorm';
import {ArreteRestriction} from '@shared/entities/arrete_restriction.entity';
import {DepartementModule} from '../departement/departement.module';
import {ArreteCadreModule} from '../arrete_cadre/arrete_cadre.module';
import {RestrictionModule} from '../restriction/restriction.module';
import {FichierModule} from '../fichier/fichier.module';
import {UserModule} from '../user/user.module';
import {SharedModule} from '../shared/shared.module';
import {ZoneAlerteComputedModule} from '../zone_alerte_computed/zone_alerte_computed.module';
import {StatisticDepartementModule} from '../statistic_departement/statistic_departement.module';
import {AbonnementMailModule} from '../abonnement_mail/abonnement_mail.module';
import {ConfigModule} from "../config/config.module";

@Module({
    imports: [
        TypeOrmModule.forFeature([ArreteRestriction]),
        DepartementModule,
        forwardRef(() => ArreteCadreModule),
        RestrictionModule,
        FichierModule,
        UserModule,
        SharedModule,
        forwardRef(() => ZoneAlerteComputedModule),
        StatisticDepartementModule,
        AbonnementMailModule,
        ConfigModule,
    ],
    controllers: [ArreteRestrictionController],
    providers: [ArreteRestrictionService],
    exports: [ArreteRestrictionService],
})
export class ArreteRestrictionModule {
}
