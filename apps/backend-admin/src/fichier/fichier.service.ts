import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeleteResult, Repository } from 'typeorm';
import { Fichier } from '@shared/entities/fichier.entity';
import { S3Service } from '../shared/services/s3.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class FichierService {
  constructor(
    @InjectRepository(Fichier)
    private readonly fichierRepository: Repository<Fichier>,
    private readonly s3Service: S3Service,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    // this.migrateFiles();
  }

  find(id: number): Promise<Fichier> {
    return this.fichierRepository.findOne({
      where: {
        id,
      },
    });
  }

  async create(fichier: Express.Multer.File, prefix: string): Promise<Fichier> {
    const s3Response = await this.s3Service.uploadFile(fichier, prefix);
    const toSave = {
      nom: fichier.originalname,
      size: fichier.size,
      url: s3Response.Location,
    };
    return this.fichierRepository.save(toSave);
  }

  async deleteById(id: number): Promise<DeleteResult> {
    const fichier = await this.find(id);
    if (!fichier) {
      return;
    }
    await this.s3Service.deleteFile(fichier.url);
    return this.fichierRepository.delete({ id });
  }

  async migrateFiles() {
    const allFiles = await this.fichierRepository.find({
      relations: ['arreteCadre', 'arreteRestriction'],
      where: {
        migrate: false,
      },
    });

    for (const file of allFiles) {
      try {
        const response = await this.httpService.axiosRef({
          url: file.url.replace(
            `${this.configService.get('S3_VHOST')}${this.configService.get('S3_PREFIX')}`,
            'https://propluvia-data.s3.gra.io.cloud.ovh.net/pdf/',
          ),
          method: 'GET',
          responseType: 'arraybuffer',
        });
        const fileToTransfer = {
          originalname: file.nom,
          buffer: Buffer.from(response.data, 'binary'),
        };
        const s3Response = await this.s3Service.uploadFile(
          // @ts-ignore
          fileToTransfer,
          file.arreteCadre
            ? `arrete-cadre/${file.arreteCadre.id}/`
            : file.arreteRestriction
              ? `arrete-restriction/${file.arreteRestriction.id}/`
              : '',
        );
        await this.fichierRepository.update(
          { id: file.id },
          { migrate: true, url: s3Response.Location },
        );
      } catch (e) {
        console.error("Erreur lors de l'upload d'un fichier", e);
      }
    }
  }
}
