import {Module} from '@nestjs/common';
import {BrevoService} from './brevo.service';
import {CommunesModule} from '../communes/communes.module';
import AuthModule from "../auth/auth.module";

@Module({
    imports: [
        CommunesModule,
        AuthModule
    ],
    controllers: [],
    providers: [BrevoService],
    exports: [BrevoService],
})
export class BrevoModule {
}