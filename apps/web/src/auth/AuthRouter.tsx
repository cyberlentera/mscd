// Chooses the sign-in or account page of the current path (BUILD-PLAN H.6). The boot (boot.tsx) owns the path,
// the history and the hand-over to the application; this component only renders the page.
import React from 'react';
import type { GuestStartResponse } from '@mscd/shared';
import type { ApiResult } from '../data/api/ApiClient';
import type { AuthEnv } from './context';
import { EnrolPage } from './EnrolPage';
import type { EnrolMode } from './EnrolPage';
import { ForgotPasswordPage } from './ForgotPasswordPage';
import { GuestPage } from './GuestPage';
import { InvitePage } from './InvitePage';
import { LoginPage } from './LoginPage';
import { MfaPage } from './MfaPage';
import { ResetPasswordPage } from './ResetPasswordPage';
import type { AuthPage, PendingReauth } from './routes';
import type { Notice } from './ui';

export interface AuthRouterProps {
  page: AuthPage;
  env: AuthEnv;
  /** Message for the page on arrival. */
  notice?: Notice | null;
  /** `?error=<code>` of an identity provider callback, for the sign-in page. */
  errorCode?: string | null;
  /** `?org=<slug>` of the address. */
  org?: string | null;
  reauth?: PendingReauth | null;
  onCancelReauth?: () => void;
  /** Enrolment during sign-in, or re-enrolment from an active session. */
  enrolMode?: EnrolMode;
  /** The second factor belongs to a guest sign-in (F.14). */
  guest?: boolean;
  /** Token of a reset or invitation link, taken from the fragment by the boot. */
  linkToken?: string | null;
  /** Answer of the guest link start, posted by the boot. */
  guestStart?: Promise<ApiResult<GuestStartResponse> | null> | null;
}

export function AuthRouter(props: AuthRouterProps) {
  const { page, env } = props;
  switch (page) {
    case 'mfa':
      return <MfaPage env={env} guest={props.guest} />;
    case 'enrol':
      return <EnrolPage env={env} mode={props.enrolMode ?? 'enrol'} />;
    case 'forgot':
      return <ForgotPasswordPage env={env} notice={props.notice} />;
    case 'reset':
      return <ResetPasswordPage env={env} token={props.linkToken ?? null} />;
    case 'invite':
      return <InvitePage env={env} token={props.linkToken ?? null} org={props.org} />;
    case 'guest':
      return <GuestPage env={env} start={props.guestStart ?? null} />;
    case 'login':
    default:
      return (
        <LoginPage
          env={env} notice={props.notice} errorCode={props.errorCode} org={props.org} reauth={props.reauth}
          onCancelReauth={props.onCancelReauth}
        />
      );
  }
}
