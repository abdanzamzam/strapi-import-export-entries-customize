import { Entry, MediaEntry, User } from '../../../types';
import { FileEntry } from '../types';
import fs from 'fs';
import fse from 'fs-extra';
import last from 'lodash/last';
import trim from 'lodash/trim';
import os from 'os';
import path from 'path';
import fetch from 'node-fetch';
import { isObjectSafe } from '../../../../libs/objects';

export { findOrImportFile };

module.exports = {
  findOrImportFile,
};

type AllowedMediaTypes = keyof typeof fileTypeCheckers;
type FileEntryMedia = {
  id: string;
  hash: string;
  name: string;
  url: string;
  alternativeText: string;
  caption: string;
};

async function findOrImportFile(fileEntry: FileEntry, user: User, { allowedFileTypes }: { allowedFileTypes: AllowedMediaTypes[] }): Promise<Entry | null> {
  if (isBase64Data(fileEntry)) {
    let file = null;
    file = await importFileBase64(fileEntry, user);
    return file;
  } else {
    let obj: Partial<FileEntryMedia> = {};
    if (typeof fileEntry === 'number') {
      obj.id = fileEntry;
    } else if (typeof fileEntry === 'string') {
      obj.url = fileEntry;
    } else if (isObjectSafe(fileEntry)) {
      obj = fileEntry;
    } else {
      throw new Error(`Invalid data format '${typeof fileEntry}' to import media. Only 'string', 'number', 'object' are accepted.`);
    }

    let file: MediaEntry | null = await findFile(obj, user, allowedFileTypes);

    if (file && !isExtensionAllowed(file.ext.substring(1), allowedFileTypes)) {
      file = null;
    }

    return file;
  }
}

const isBase64Data = (fileEntry: any) => {
  const base64RegExp = /^data:([a-z]+\/[a-z]+);base64,([a-zA-Z0-9+/=]+)$/;
  return base64RegExp.test(fileEntry);
};

const findFile = async (
  { id, hash, name, url, alternativeText, caption }: Partial<FileEntryMedia>,
  user: User,
  allowedFileTypes: AllowedMediaTypes[],
): Promise<MediaEntry | null> => {
  let file = null;

  if (!file && id) {
    file = await strapi.entityService.findOne('plugin::upload.file', id);
  }
  if (!file && hash) {
    [file] = await strapi.entityService.findMany('plugin::upload.file', { filters: { hash }, limit: 1 });
  }
  if (!file && name) {
    [file] = await strapi.entityService.findMany('plugin::upload.file', { filters: { name }, limit: 1 });
  }
  if (!file && url) {
    const checkResult = isValidFileUrl(url, allowedFileTypes);
    if (checkResult.isValid) {
      file = await findFile({ hash: checkResult.fileData.hash, name: checkResult.fileData.fileName }, user, allowedFileTypes);

      if (!file) {
        file = await importFile({ id: id!, url: checkResult.fileData.rawUrl, name: name!, alternativeText: alternativeText!, caption: caption! }, user);
      }
    }
  }

  return file;
};

const importFile = async (
  { id, url, name, alternativeText, caption }: { id: string; url: string; name: string; alternativeText: string; caption: string },
  user: User,
): Promise<MediaEntry> => {
  let file;
  try {
    file = await fetchFile(url);

    let [uploadedFile] = await strapi
      .plugin('upload')
      .service('upload')
      .upload(
        {
          files: {
            name: file.name,
            type: file.type,
            size: file.size,
            path: file.path,
          },
          data: {
            fileInfo: {
              name: name || file.name,
              alternativeText: alternativeText || '',
              caption: caption || '',
            },
          },
        },
        { user },
      );

    if (id) {
      uploadedFile = await strapi.db.query('plugin::upload.file').update({
        where: { id: uploadedFile.id },
        data: { id },
      });
    }

    return uploadedFile;
  } catch (err) {
    strapi.log.error(err);
    throw err;
  } finally {
    if (file?.path) {
      deleteFileIfExists(file?.path);
    }
  }
};

const importFileBase64 = async (base64Data: any, user: User): Promise<MediaEntry> => {
  let file;
  try {
    file = await writeFileBase64(base64Data);

    let [uploadedFile] = await strapi
      .plugin('upload')
      .service('upload')
      .upload(
        {
          files: {
            name: file.name,
            type: file.type,
            size: file.size,
            path: file.path,
          },
          data: {
            fileInfo: {
              name: file.name,
              alternativeText: '',
              caption: '',
            },
          },
        },
        { user },
      );

    // if (id) {
    //   uploadedFile = await strapi.db.query('plugin::upload.file').update({
    //     where: { id: uploadedFile.id },
    //     data: { id },
    //   });
    // }

    return uploadedFile;
  } catch (err) {
    strapi.log.error(err);
    throw err;
  } finally {
    if (file?.path) {
      deleteFileIfExists(file?.path);
    }
  }
};

const fetchFile = async (
  url: string,
): Promise<{
  name: string;
  type: string;
  size: number;
  path: string;
}> => {
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type')?.split(';')?.[0] || '';
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10) || 0;
    const buffer = await response.buffer();
    const fileData = getFileDataFromRawUrl(url);
    const filePath = await writeFile(fileData.name, buffer);
    return {
      name: fileData.name,
      type: contentType,
      size: contentLength,
      path: filePath,
    };
  } catch (error: any) {
    throw new Error(`Tried to fetch file from url ${url} but failed with error: ${error.message}`);
  }
};

const writeFile = async (name: string, content: Buffer): Promise<string> => {
  const tmpWorkingDirectory = await fse.mkdtemp(path.join(os.tmpdir(), 'strapi-upload-'));

  const filePath = path.join(tmpWorkingDirectory, name);
  try {
    fs.writeFileSync(filePath, content);
    return filePath;
  } catch (err) {
    strapi.log.error(err);
    throw err;
  }
};

const writeFileBase64 = async (base64Data: string): Promise<any> => {
  const dataURIComponents = base64Data.split(';');
  const mimeType = dataURIComponents[0].split(':')[1];
  const imageExtension = mimeType.split('/')[1];
  const filename = `image-${Date.now()}.${imageExtension}`;
  const base64Image = base64Data.split(',')[1];
  const content = Buffer.from(base64Image, 'base64');
  const fileInfo = getFileInfoFromBase64Image(base64Data, filename);
  const tmpWorkingDirectory = await fse.mkdtemp(path.join(os.tmpdir(), 'strapi-upload-'));

  const filePath = path.join(tmpWorkingDirectory, filename);
  try {
    fs.writeFileSync(filePath, content);
    return {
      name: filename,
      type: mimeType,
      size: fileInfo.size,
      path: filePath,
    };
  } catch (err) {
    strapi.log.error(err);
    throw err;
  }
};

const getFileInfoFromBase64Image = (base64Data: string, filename: string) => {
  const bufferData = Buffer.from(base64Data, 'base64');
  const fileSize = bufferData.length;

  return {
    name: filename,
    size: fileSize
  };
};

const deleteFileIfExists = (filePath: string): void => {
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
};

const isValidFileUrl = (
  url: string,
  allowedFileTypes: AllowedMediaTypes[],
): {
  isValid: boolean;
  fileData: {
    hash: string;
    fileName: string;
    rawUrl: string;
  };
} => {
  try {
    const fileData = getFileDataFromRawUrl(url);

    return {
      isValid: isExtensionAllowed(fileData.extension, allowedFileTypes),
      fileData: {
        hash: fileData.hash,
        fileName: fileData.name,
        rawUrl: url,
      },
    };
  } catch (err) {
    strapi.log.error(err);
    return {
      isValid: false,
      fileData: {
        hash: '',
        fileName: '',
        rawUrl: '',
      },
    };
  }
};

const isExtensionAllowed = (ext: string, allowedFileTypes: AllowedMediaTypes[]) => {
  const checkers = allowedFileTypes.map(getFileTypeChecker);
  return checkers.some((checker) => checker(ext));
};

const ALLOWED_AUDIOS = ['mp3', 'wav', 'ogg'];
const ALLOWED_IMAGES = ['png', 'gif', 'jpg', 'jpeg', 'svg', 'bmp', 'tif', 'tiff'];
const ALLOWED_VIDEOS = ['mp4', 'avi'];

/** See Strapi file allowedTypes for object keys. */
const fileTypeCheckers = {
  any: (ext: string) => true,
  audios: (ext: string) => ALLOWED_AUDIOS.includes(ext),
  files: (ext: string) => true,
  images: (ext: string) => ALLOWED_IMAGES.includes(ext),
  videos: (ext: string) => ALLOWED_VIDEOS.includes(ext),
} as const;

const getFileTypeChecker = (type: AllowedMediaTypes) => {
  const checker = fileTypeCheckers[type];
  if (!checker) {
    throw new Error(`Strapi file type ${type} not handled.`);
  }
  return checker;
};

const getFileDataFromRawUrl = (
  rawUrl: string,
): {
  hash: string;
  name: string;
  extension: string;
} => {
  const parsedUrl = new URL(decodeURIComponent(rawUrl));

  const name = trim(parsedUrl.pathname, '/').replace(/\//g, '-');
  const extension = parsedUrl.pathname.split('.').pop()?.toLowerCase() || '';
  const hash = last(parsedUrl.pathname.split('/'))?.slice(0, -(extension!.length + 1)) || '';

  return {
    hash,
    name,
    extension,
  };
};
