import { Injectable } from '@nestjs/common';
import { RegleauLogger } from '../../logger/regleau.logger';
import {
  DeleteObjectCommand,
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3,
  type CopyObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ConfigService } from '@nestjs/config';

export type S3ObjectAcl = 'private' | 'public-read';

export interface S3WriteOptions {
  acl?: S3ObjectAcl;
  cacheControl?: string;
  contentDisposition?: string;
  contentType?: string;
}

export interface S3OperationOptions extends S3WriteOptions {
  abortSignal?: AbortSignal;
}

@Injectable()
export class S3Service {
  private readonly logger = new RegleauLogger('S3Service');
  private readonly client: S3;

  constructor(private readonly configService: ConfigService) {
    const forcePathStyle =
      this.configService.get<string>('S3_FORCE_PATH_STYLE') === 'true' ||
      this.configService.get<string>('NODE_ENV') === 'local';

    this.client = new S3(<any>{
      region: this.configService.get<string>('S3_REGION'),
      endpoint: this.configService.get<string>('S3_ENDPOINT'),
      forcePathStyle,
      credentials: {
        accessKeyId: this.configService.get<string>('S3_ACCESS_KEY'),
        secretAccessKey: this.configService.get<string>('S3_SECRET_KEY'),
      },
    });
  }

  // async deleteAllFiles() {
  //   const client = this.client;
  //   let count = 0; // number of files deleted
  //   async function recursiveDelete(token: string = null) {
  //     // get the files
  //     const listCommand = new ListObjectsV2Command({
  //       Bucket: this.configService.get('S3_BUCKET'),
  //       Prefix: 'dev/',
  //       ContinuationToken: token,
  //     });
  //     const list = await client.send(listCommand);
  //     if (list.KeyCount) {
  //       // if items to delete
  //       // delete the files
  //       const deleteCommand = new DeleteObjectsCommand({
  //         Bucket: this.configService.get('S3_BUCKET'),
  //         Delete: {
  //           Objects: list.Contents.map((item) => ({ Key: item.Key })),
  //           Quiet: false,
  //         },
  //       });
  //       const deleted = await client.send(deleteCommand);
  //       count += deleted.Deleted.length;
  //       // log any errors deleting files
  //       if (deleted.Errors) {
  //         deleted.Errors.map((error) =>
  //           console.log(`${error.Key} could not be deleted - ${error.Code}`),
  //         );
  //       }
  //     }
  //     // repeat if more files to delete
  //     if (list.NextContinuationToken) {
  //       recursiveDelete(list.NextContinuationToken);
  //     }
  //     // return total deleted count when finished
  //     return `${count} files deleted.`;
  //   }
  //   // start the recursive function
  //   return recursiveDelete();
  // }

  async uploadFile(
    file: Express.Multer.File,
    prefix: string = '',
    options: S3OperationOptions = {},
  ) {
    const { originalname } = file;

    this.logger.log(`UPLOADING ${prefix} ${originalname}`);
    return await this.s3_upload(
      file.buffer,
      this.configService.get('S3_BUCKET'),
      (this.configService.get('S3_PREFIX') || '') + prefix + originalname,
      options.contentType || file.mimetype,
      options,
    );
  }

  async deleteFile(fileUrl: string) {
    const client = this.client;
    const params = {
      Bucket: this.configService.get('S3_BUCKET'),
      Key: fileUrl.replace(this.configService.get('S3_VHOST'), ''),
    };
    try {
      await client.send(new DeleteObjectCommand(params));
    } catch (e) {
      this.logger.error("Erreur lors de la suppression d'un fichier", e);
    }
  }

  async copyFile(
    fileName: string,
    newFileName: string,
    prefix: string = '',
    options?: S3OperationOptions,
  ) {
    const oldFileUrl =
      '/' +
      this.configService.get('S3_BUCKET') +
      '/' +
      (this.configService.get('S3_PREFIX') || '') +
      prefix +
      fileName;
    const newFileUrl =
      (this.configService.get('S3_PREFIX') || '') + prefix + newFileName;
    this.logger.log(`COPY FILE ${oldFileUrl} -> ${newFileUrl}`);

    const client = this.client;
    const params: CopyObjectCommandInput = {
      Bucket: this.configService.get('S3_BUCKET'),
      CopySource: encodeURI(oldFileUrl),
      Key: String(newFileUrl),
      ACL: options?.acl ?? 'public-read',
      ...(options?.cacheControl ||
      options?.contentDisposition ||
      options?.contentType
        ? {
            ...(options.cacheControl
              ? { CacheControl: options.cacheControl }
              : {}),
            ...(options.contentDisposition
              ? { ContentDisposition: options.contentDisposition }
              : {}),
            ...(options.contentType
              ? { ContentType: options.contentType }
              : {}),
            MetadataDirective: 'REPLACE' as const,
          }
        : {}),
    };
    return await client.send(new CopyObjectCommand(params), {
      abortSignal: options?.abortSignal,
    });
  }

  getPublicFileUrl(fileName: string, prefix: string = ''): string {
    const baseUrl = String(this.configService.get('S3_VHOST') || '').replace(
      /\/+$/,
      '',
    );
    if (!baseUrl) {
      throw new Error('S3_VHOST is required to build a public file URL');
    }
    const key =
      `${this.configService.get('S3_PREFIX') || ''}${prefix}${fileName}`
        .replace(/^\/+/, '')
        .replace(/\/{2,}/g, '/');
    return `${baseUrl}/${key}`;
  }

  async headFile(
    fileName: string,
    prefix: string = '',
    options?: Pick<S3OperationOptions, 'abortSignal'>,
  ) {
    const key = `${this.configService.get('S3_PREFIX') || ''}${prefix}${fileName}`;
    return this.client.send(
      new HeadObjectCommand({
        Bucket: this.configService.get('S3_BUCKET'),
        Key: key,
      }),
      { abortSignal: options?.abortSignal },
    );
  }

  async downloadFile(
    fileName: string,
    prefix: string = '',
    options?: Pick<S3OperationOptions, 'abortSignal'>,
  ): Promise<Buffer> {
    const key = `${this.configService.get('S3_PREFIX') || ''}${prefix}${fileName}`;
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.configService.get('S3_BUCKET'),
        Key: key,
      }),
      { abortSignal: options?.abortSignal },
    );
    if (!response.Body) {
      throw new Error(`S3 object ${key} has no body`);
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async s3_upload(
    file,
    bucket,
    name,
    mimetype,
    options: S3OperationOptions = {},
  ) {
    const client = this.client;
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: String(name),
        Body: file,
        ACL: options.acl ?? 'public-read',
        ContentType: mimetype,
        ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        ...(options.contentDisposition
          ? { ContentDisposition: options.contentDisposition }
          : {}),
      },
    });

    const abortUpload = () => {
      void upload.abort().catch(() => undefined);
    };
    if (options.abortSignal?.aborted) {
      abortUpload();
    } else {
      options.abortSignal?.addEventListener('abort', abortUpload, {
        once: true,
      });
    }

    try {
      return await upload.done();
    } catch (e) {
      this.logger.error("Erreur lors de l'upload d'un fichier", e);
      throw e;
    } finally {
      options.abortSignal?.removeEventListener('abort', abortUpload);
    }
  }
}
