import './instrument';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { VigieauLogger } from './logger/vigieau.logger';
import helmet from 'helmet';
import { ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHttpFailureLoggingMiddleware } from './core/middleware/http-failure-logging.middleware';
import { isPreproductionAuthEnabled } from './core/preproduction-auth';

async function bootstrap() {
  const preproductionAuthEnabled = isPreproductionAuthEnabled();
  const app = await NestFactory.create(AppModule);

  // Logger personnalisé
  app.useLogger(app.get(VigieauLogger));

  // Observe final HTTP outcomes, including failures before Nest interceptors.
  app.use(createHttpFailureLoggingMiddleware());

  // Middlewares de sécurité
  app.use(helmet());
  app.enableCors({
    origin: '*',
  });

  // Middleware global
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.setGlobalPrefix('api');
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  // OpenAPI/Swagger
  const options = new DocumentBuilder()
    .setTitle('API VigiEau')
    .setDescription("Documentation de l'API VigiEau")
    .setVersion('0.1')
    .build();
  const document = SwaggerModule.createDocument(app, options);
  SwaggerModule.setup('swagger', app, document);

  // Gestion du port
  const configService = app.get(ConfigService);
  const port = configService.get('PORT');
  if (preproductionAuthEnabled) {
    // Only the authentication gateway in this container may reach the API.
    await app.listen(port, '127.0.0.1');
  } else {
    await app.listen(port);
  }
}

bootstrap();
