import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { Response } from 'express';
import { Fichier } from '@shared/entities/fichier.entity';
import { User } from '@shared/entities/user.entity';
import { AuthenticatedGuard } from '../core/guards/authenticated.guard';
import { canAccessDocument } from './fichier-access';

@Controller('fichier')
@ApiTags('Documents')
@UseGuards(AuthenticatedGuard)
export class FichierController {
  constructor(private readonly dataSource: DataSource) {}

  @Get(':id/access')
  @ApiOperation({
    summary:
      "Tracer une demande d'accès au document puis rediriger vers son stockage",
  })
  async access(
    @Req() req,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    if (typeof req.session?.user?.email !== 'string' || !req.session.user.email)
      throw new UnauthorizedException();
    const user = await this.dataSource
      .getRepository(User)
      .findOneBy({ email: req.session?.user?.email });
    if (!user) throw new UnauthorizedException();
    const file = await this.dataSource.getRepository(Fichier).findOne({
      where: { id },
      relations: [
        'arreteCadre',
        'arreteCadre.departements',
        'arreteRestriction',
        'arreteRestriction.departement',
        'arreteMunicipal',
        'arreteMunicipal.communes',
        'arreteMunicipal.communes.departement',
      ],
    });
    if (!canAccessDocument(user, file)) throw new NotFoundException();
    let url: URL;
    try {
      url = new URL(file.url);
    } catch {
      throw new NotFoundException();
    }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new NotFoundException();
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(302, url.toString());
  }
}
