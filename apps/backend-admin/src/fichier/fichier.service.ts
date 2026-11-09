import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeleteResult, Repository } from 'typeorm';
import { Fichier } from '@shared/entities/fichier.entity';
import { S3Service } from '../shared/services/s3.service';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AntivirusService } from '../antivirus/antivirus.service';

@Injectable()
export class FichierService {
  constructor(
    @InjectRepository(Fichier)
    private readonly fichierRepository: Repository<Fichier>,
    private readonly s3Service: S3Service,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly antivirus: AntivirusService,
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
    await this.scanOrThrow(fichier);
    const s3Response = await this.s3Service.uploadFile(fichier, prefix);
    const toSave = {
      nom: fichier.originalname,
      size: fichier.size,
      url: s3Response.Location,
    };
    return this.fichierRepository.save(toSave);
  }

  scanOrThrow(fichier: Express.Multer.File): Promise<void> {
    return this.antivirus.scanOrThrow(fichier);
  }

  async createImmutable(
    fichier: Express.Multer.File,
    prefix: string,
  ): Promise<Fichier> {
    return this.create(fichier, `${prefix}${randomUUID()}/`);
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
          maxContentLength: 10_000_000,
          timeout: 30_000,
        });
        const fileToTransfer = {
          originalname: file.nom,
          buffer: Buffer.from(response.data, 'binary'),
          size: Buffer.byteLength(response.data),
        };
        await this.scanOrThrow(fileToTransfer as Express.Multer.File);
        const s3Response = await this.s3Service.uploadFile(
          // @ts-expect-error legacy transfer payload only exposes used fields
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
