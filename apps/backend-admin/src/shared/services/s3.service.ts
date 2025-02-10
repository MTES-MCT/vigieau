import { Injectable } from '@nestjs/common';
import { RegleauLogger } from '../../logger/regleau.logger';
import {
  DeleteObjectCommand,
  CopyObjectCommand,
  S3,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

@Injectable()
export class S3Service {
  private readonly logger = new RegleauLogger('S3Service');
  private readonly client = new S3(<any> {
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });

  constructor() {
  }

  // async deleteAllFiles() {
  //   const client = this.client;
  //   let count = 0; // number of files deleted
  //   async function recursiveDelete(token: string = null) {
  //     // get the files
  //     const listCommand = new ListObjectsV2Command({
  //       Bucket: process.env.S3_BUCKET,
  //       Prefix: 'dev/',
  //       ContinuationToken: token,
  //     });
  //     const list = await client.send(listCommand);
  //     if (list.KeyCount) {
  //       // if items to delete
  //       // delete the files
  //       const deleteCommand = new DeleteObjectsCommand({
  //         Bucket: process.env.S3_BUCKET,
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

  async uploadFile(file: Express.Multer.File, prefix: string = '') {
    const { originalname } = file;

    this.logger.log(`UPLOADING ${prefix} ${originalname}`);
    return await this.s3_upload(
      file.buffer,
      process.env.S3_BUCKET,
      (process.env.S3_PREFIX || '') + prefix + originalname,
      file.mimetype,
    );
  }

  async deleteFile(fileUrl: string) {
    const client = this.client;
    const params = {
      Bucket: process.env.S3_BUCKET,
      Key: fileUrl.replace(process.env.S3_VHOST, ''),
    };
    try {
      await client.send(new DeleteObjectCommand(params));
    } catch (e) {
      this.logger.error('Erreur lors de la suppression d\'un fichier', e);
    }
  }

  async copyFile(fileName: string, newFileName: string, prefix: string = '') {
    const oldFileUrl = '/' + process.env.S3_BUCKET + '/' + (process.env.S3_PREFIX || '') + prefix + fileName;
    const newFileUrl = (process.env.S3_PREFIX || '') + prefix + newFileName;
    this.logger.log(`COPY FILE ${oldFileUrl} -> ${newFileUrl}`);

    const client = this.client;
    const params = {
      Bucket: process.env.S3_BUCKET,
      CopySource: encodeURI(oldFileUrl),
      Key: String(newFileUrl),
      ACL: 'public-read',
    }
    //@ts-ignore
    return await client.send(new CopyObjectCommand(params));
  }

  async s3_upload(file, bucket, name, mimetype) {
    const client = this.client;
    const upload = new Upload({
      client,
      params: {
        Bucket: bucket,
        Key: String(name),
        Body: file,
        ACL: 'public-read',
        ContentType: mimetype,
      },
    });

    try {
      return await upload.done();
    } catch (e) {
      this.logger.error('Erreur lors de l\'upload d\'un fichier', e);
    }
  }
}
