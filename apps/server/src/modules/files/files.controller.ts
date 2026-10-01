// The file routes of D.3 (WP-21): repository browse, upload intents with their content and completion, evidence
// files, document versions, and opening, redirecting to and reading storage objects.
import { Controller, Req, Res } from '@nestjs/common';
import {
  documentVersionsRoute,
  evidenceFilesRoute,
  storageBrowseRoute,
  storageObjectContentRoute,
  storageObjectOpenRoute,
  storageObjectRedirectRoute,
  uploadIntentsCompleteRoute,
  uploadIntentsContentRoute,
  uploadIntentsCreateRoute,
  type BrowseQuery,
  type CommandResult,
  type DocumentVersionRequest,
  type EvidenceFileRequest,
  type IdParams,
  type MsRecordParams,
  type ObjectOpenResponse,
  type PickerListing,
  type RepositoryParams,
  type UploadCompleteRequest,
  type UploadIntent,
  type UploadIntentRequest,
  type UploadResult,
} from '@mscd/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiRoute, CurrentAuthz, CurrentPrincipal, RouteInputParam } from '../../common/api-route';
import type { AuthzState, Principal } from '../../common/tokens';
import { FileCommandsService } from './file-commands.service';
import { ObjectAccessService } from './object-access.service';
import { UploadsService } from './uploads.service';

@Controller()
export class FilesController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly commands: FileCommandsService,
    private readonly objects: ObjectAccessService,
  ) {}

  @ApiRoute(storageBrowseRoute)
  browse(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: RepositoryParams,
    @RouteInputParam('query') query: BrowseQuery,
  ): Promise<PickerListing> {
    return this.uploads.browse(principal, params.slug, query);
  }

  @ApiRoute(uploadIntentsCreateRoute)
  createIntent(@CurrentPrincipal() principal: Principal, @RouteInputParam('body') body: UploadIntentRequest): Promise<UploadIntent> {
    return this.uploads.createIntent(principal, body);
  }

  @ApiRoute(uploadIntentsContentRoute)
  content(@CurrentPrincipal() principal: Principal, @RouteInputParam('params') params: IdParams, @Req() request: FastifyRequest): Promise<UploadResult> {
    return this.uploads.putContent(principal, params.id, request);
  }

  @ApiRoute(uploadIntentsCompleteRoute)
  complete(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('body') body: UploadCompleteRequest,
  ): Promise<UploadResult> {
    return this.uploads.complete(principal, params.id, body.externalItemId);
  }

  @ApiRoute(evidenceFilesRoute)
  evidenceFile(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: EvidenceFileRequest,
  ): Promise<CommandResult> {
    return this.commands.evidenceFile(principal, params.ms, params.id, body, authz?.ownOnly === true);
  }

  @ApiRoute(documentVersionsRoute)
  documentVersion(
    @CurrentPrincipal() principal: Principal,
    @CurrentAuthz() authz: AuthzState | null,
    @RouteInputParam('params') params: MsRecordParams,
    @RouteInputParam('body') body: DocumentVersionRequest,
  ): Promise<CommandResult> {
    return this.commands.documentVersion(principal, params.ms, params.id, body, authz?.ownOnly === true);
  }

  @ApiRoute(storageObjectOpenRoute)
  open(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('query') query: { ms: string },
    @Req() request: FastifyRequest,
  ): Promise<ObjectOpenResponse> {
    return this.objects.open(principal, params.id, query.ms, request);
  }

  @ApiRoute(storageObjectRedirectRoute)
  async redirect(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('query') query: { t: string },
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.objects.redirect(principal, params.id, query.t, reply);
  }

  @ApiRoute(storageObjectContentRoute)
  async read(
    @CurrentPrincipal() principal: Principal,
    @RouteInputParam('params') params: IdParams,
    @RouteInputParam('query') query: { ms: string; inline?: boolean },
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.objects.content(principal, params.id, query.ms, query.inline === true, request, reply);
  }
}
