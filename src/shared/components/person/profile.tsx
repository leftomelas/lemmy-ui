import {
  editComment,
  editPost,
  editWith,
  enableDownvotes,
  enableNsfw,
  postToCommentSortType,
  setIsoData,
  updatePersonBlock,
  voteDisplayMode,
} from "@utils/app";
import { scrollMixin } from "../mixins/scroll-mixin";
import {
  capitalizeFirstLetter,
  futureDaysToUnixTime,
  getPageFromString,
  getQueryParams,
  getQueryString,
  numToSI,
  randomStr,
  resourcesSettled,
  bareRoutePush,
} from "@utils/helpers";
import { amAdmin, canMod } from "@utils/roles";
import type { QueryParams } from "@utils/types";
import { RouteDataResponse } from "@utils/types";
import classNames from "classnames";
import { format } from "date-fns";
import { NoOptionI18nKeys } from "i18next";
import { Component, linkEvent } from "inferno";
import { Link } from "inferno-router";
import { RouteComponentProps } from "inferno-router/dist/Route";
import {
  AddAdmin,
  AddModToCommunity,
  BanFromCommunity,
  BanFromCommunityResponse,
  BanPerson,
  BanPersonResponse,
  BlockPerson,
  CommentReplyResponse,
  CommentResponse,
  Community,
  CommunityModeratorView,
  CreateComment,
  CreateCommentLike,
  CreateCommentReport,
  CreatePostLike,
  CreatePostReport,
  DeleteComment,
  DeletePost,
  DistinguishComment,
  EditComment,
  EditPost,
  FeaturePost,
  GetPersonDetails,
  GetPersonDetailsResponse,
  GetSiteResponse,
  LemmyHttp,
  ListMedia,
  ListMediaResponse,
  LockPost,
  MarkCommentReplyAsRead,
  MarkPersonMentionAsRead,
  PersonView,
  PostResponse,
  PurgeComment,
  PurgePerson,
  PurgePost,
  RemoveComment,
  RemovePost,
  SaveComment,
  SavePost,
  PostSortType,
  SuccessResponse,
  TransferCommunity,
  RegistrationApplicationResponse,
  GetPosts,
  GetComments,
  GetPostsResponse,
  GetCommentsResponse,
} from "lemmy-js-client";
import { fetchLimit, relTags } from "../../config";
import { InitialFetchRequest, PersonDetailsView } from "../../interfaces";
import { mdToHtml } from "../../markdown";
import { FirstLoadService, I18NextService, UserService } from "../../services";
import {
  EMPTY_REQUEST,
  HttpService,
  LOADING_REQUEST,
  RequestState,
  wrapClient,
} from "../../services/HttpService";
import { toast } from "../../toast";
import { BannerIconHeader } from "../common/banner-icon-header";
import { HtmlTags } from "../common/html-tags";
import { Icon, Spinner } from "../common/icon";
import { MomentTime } from "../common/moment-time";
import { SortSelect } from "../common/sort-select";
import { UserBadges } from "../common/user-badges";
import { CommunityLink } from "../community/community-link";
import { PersonDetails } from "./person-details";
import { PersonListing } from "./person-listing";
import { getHttpBaseInternal } from "../../utils/env";
import { IRoutePropsWithFetch } from "../../routes";
import { MediaUploads } from "../common/media-uploads";
import { cakeDate } from "@utils/helpers";
import { isBrowser } from "@utils/browser";
import DisplayModal from "../common/modal/display-modal";

type ProfileData = RouteDataResponse<{
  personRes: GetPersonDetailsResponse;
  uploadsRes: ListMediaResponse;
  likedPostsRes: GetPostsResponse;
  likedCommentsRes: GetCommentsResponse;
}>;

interface ProfileState {
  personRes: RequestState<GetPersonDetailsResponse>;
  // personRes and personDetailsRes point to `===` identical data. This allows
  // to render the start of the profile while the new details are loading.
  personDetailsRes: RequestState<GetPersonDetailsResponse>;
  likedCommentsRes: RequestState<GetCommentsResponse>;
  likedPostsRes: RequestState<GetPostsResponse>;
  uploadsRes: RequestState<ListMediaResponse>;
  registrationRes: RequestState<RegistrationApplicationResponse>;
  personBlocked: boolean;
  banReason?: string;
  banExpireDays?: number;
  showBanDialog: boolean;
  removeOrRestoreData: boolean;
  siteRes: GetSiteResponse;
  isIsomorphic: boolean;
  showRegistrationDialog: boolean;
}

interface ProfileProps {
  view: PersonDetailsView;
  sort: PostSortType;
  page: number;
}

export function getProfileQueryParams(source?: string): ProfileProps {
  return getQueryParams<ProfileProps>(
    {
      view: getViewFromProps,
      page: getPageFromString,
      sort: getSortTypeFromQuery,
    },
    source,
  );
}

function getSortTypeFromQuery(sort?: string): PostSortType {
  return sort ? (sort as PostSortType) : "New";
}

function getViewFromProps(view?: string): PersonDetailsView {
  return view
    ? (PersonDetailsView[view] ?? PersonDetailsView.Overview)
    : PersonDetailsView.Overview;
}

const getCommunitiesListing = (
  translationKey: NoOptionI18nKeys,
  communityViews?: { community: Community }[],
) =>
  communityViews &&
  communityViews.length > 0 && (
    <div className="card border-secondary mb-3">
      <div className="card-body">
        <h2 className="h5">{I18NextService.i18n.t(translationKey)}</h2>
        <ul className="list-unstyled mb-0">
          {communityViews.map(({ community }) => (
            <li key={community.id}>
              <CommunityLink community={community} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );

const Moderates = ({ moderates }: { moderates?: CommunityModeratorView[] }) =>
  getCommunitiesListing("moderates", moderates);

const Follows = () =>
  getCommunitiesListing("subscribed", UserService.Instance.myUserInfo?.follows);

function isPersonBlocked(personRes: RequestState<GetPersonDetailsResponse>) {
  return (
    (personRes.state === "success" &&
      UserService.Instance.myUserInfo?.person_blocks.some(
        ({ id }) => id === personRes.data.person_view.person.id,
      )) ??
    false
  );
}

type ProfilePathProps = { username: string };
type ProfileRouteProps = RouteComponentProps<ProfilePathProps> & ProfileProps;
export type ProfileFetchConfig = IRoutePropsWithFetch<
  ProfileData,
  ProfilePathProps,
  ProfileProps
>;

@scrollMixin
export class Profile extends Component<ProfileRouteProps, ProfileState> {
  private isoData = setIsoData<ProfileData>(this.context);
  state: ProfileState = {
    personRes: EMPTY_REQUEST,
    personDetailsRes: EMPTY_REQUEST,
    likedCommentsRes: EMPTY_REQUEST,
    likedPostsRes: EMPTY_REQUEST,
    uploadsRes: EMPTY_REQUEST,
    personBlocked: false,
    siteRes: this.isoData.site_res,
    showBanDialog: false,
    removeOrRestoreData: false,
    isIsomorphic: false,
    showRegistrationDialog: false,
    registrationRes: EMPTY_REQUEST,
  };

  loadingSettled() {
    return resourcesSettled([
      this.state.personRes,
      this.state.likedCommentsRes,
      this.state.likedPostsRes,
      this.props.view === PersonDetailsView.Uploads
        ? this.state.uploadsRes
        : this.state.personDetailsRes,
    ]);
  }

  constructor(props: ProfileRouteProps, context: any) {
    super(props, context);

    this.handleSortChange = this.handleSortChange.bind(this);
    this.handlePageChange = this.handlePageChange.bind(this);

    this.handleBlockPerson = this.handleBlockPerson.bind(this);
    this.handleUnblockPerson = this.handleUnblockPerson.bind(this);

    this.handleCreateComment = this.handleCreateComment.bind(this);
    this.handleEditComment = this.handleEditComment.bind(this);
    this.handleSaveComment = this.handleSaveComment.bind(this);
    this.handleBlockPersonAlt = this.handleBlockPersonAlt.bind(this);
    this.handleDeleteComment = this.handleDeleteComment.bind(this);
    this.handleRemoveComment = this.handleRemoveComment.bind(this);
    this.handleCommentVote = this.handleCommentVote.bind(this);
    this.handleAddModToCommunity = this.handleAddModToCommunity.bind(this);
    this.handleAddAdmin = this.handleAddAdmin.bind(this);
    this.handlePurgePerson = this.handlePurgePerson.bind(this);
    this.handlePurgeComment = this.handlePurgeComment.bind(this);
    this.handleCommentReport = this.handleCommentReport.bind(this);
    this.handleDistinguishComment = this.handleDistinguishComment.bind(this);
    this.handleTransferCommunity = this.handleTransferCommunity.bind(this);
    this.handleCommentReplyRead = this.handleCommentReplyRead.bind(this);
    this.handlePersonMentionRead = this.handlePersonMentionRead.bind(this);
    this.handleBanFromCommunity = this.handleBanFromCommunity.bind(this);
    this.handleBanPerson = this.handleBanPerson.bind(this);
    this.handlePostVote = this.handlePostVote.bind(this);
    this.handlePostEdit = this.handlePostEdit.bind(this);
    this.handlePostReport = this.handlePostReport.bind(this);
    this.handleLockPost = this.handleLockPost.bind(this);
    this.handleDeletePost = this.handleDeletePost.bind(this);
    this.handleRemovePost = this.handleRemovePost.bind(this);
    this.handleSavePost = this.handleSavePost.bind(this);
    this.handlePurgePost = this.handlePurgePost.bind(this);
    this.handleFeaturePost = this.handleFeaturePost.bind(this);
    this.handleModBanSubmit = this.handleModBanSubmit.bind(this);
    this.handleRegistrationShow = this.handleRegistrationShow.bind(this);
    this.handleRegistrationClose = this.handleRegistrationClose.bind(this);

    // Only fetch the data if coming from another route
    if (FirstLoadService.isFirstLoad) {
      const personRes = this.isoData.routeData.personRes;
      const likedCommentsRes = this.isoData.routeData.likedCommentsRes;
      const likedPostsRes = this.isoData.routeData.likedPostsRes;
      const uploadsRes = this.isoData.routeData.uploadsRes;
      this.state = {
        ...this.state,
        personRes,
        likedCommentsRes,
        likedPostsRes,
        personDetailsRes: personRes,
        uploadsRes,
        isIsomorphic: true,
        personBlocked: isPersonBlocked(personRes),
      };
    }
  }

  async componentWillMount() {
    if (!this.state.isIsomorphic && isBrowser()) {
      await this.fetchUserData(this.props, true);
    }
  }

  componentWillReceiveProps(nextProps: ProfileRouteProps) {
    // Overview, Posts and Comments views can use the same data.
    const sharedViewTypes = [nextProps.view, this.props.view].every(
      v =>
        v === PersonDetailsView.Overview ||
        v === PersonDetailsView.Posts ||
        v === PersonDetailsView.Comments,
    );

    const reload = bareRoutePush(this.props, nextProps);

    const newUsername =
      nextProps.match.params.username !== this.props.match.params.username;

    if (
      (nextProps.view !== this.props.view && !sharedViewTypes) ||
      nextProps.sort !== this.props.sort ||
      nextProps.page !== this.props.page ||
      newUsername ||
      reload
    ) {
      this.fetchUserData(nextProps, reload || newUsername);
    }
  }

  fetchUploadsToken?: symbol;
  async fetchUploads(props: ProfileRouteProps) {
    if (!this.amCurrentUser) {
      return;
    }

    const token = (this.fetchUploadsToken = Symbol());
    const { page } = props;
    this.setState({ uploadsRes: LOADING_REQUEST });
    const form: ListMedia = {
      // userId?
      page,
      limit: fetchLimit,
    };
    const uploadsRes = await HttpService.client.listMedia(form);
    if (token === this.fetchUploadsToken) {
      this.setState({ uploadsRes });
    }
  }

  fetchUserDataToken?: symbol;
  async fetchUserData(props: ProfileRouteProps, showBothLoading = false) {
    const token = (this.fetchUploadsToken = this.fetchUserDataToken = Symbol());
    const { page, sort, view } = props;

    const requestLiked = view === PersonDetailsView.Upvoted;

    if (view === PersonDetailsView.Uploads) {
      this.fetchUploads(props);
      this.setState({
        likedCommentsRes: EMPTY_REQUEST,
        likedPostsRes: EMPTY_REQUEST,
      });
      if (!showBothLoading) {
        return;
      }
      this.setState({
        personRes: LOADING_REQUEST,
        personDetailsRes: LOADING_REQUEST,
      });
    } else {
      if (showBothLoading) {
        this.setState({
          personRes: LOADING_REQUEST,
          personDetailsRes: LOADING_REQUEST,
          likedCommentsRes: requestLiked ? LOADING_REQUEST : EMPTY_REQUEST,
          likedPostsRes: requestLiked ? LOADING_REQUEST : EMPTY_REQUEST,
          uploadsRes: EMPTY_REQUEST,
        });
      } else {
        this.setState({
          personDetailsRes: LOADING_REQUEST,
          likedCommentsRes: requestLiked ? LOADING_REQUEST : EMPTY_REQUEST,
          likedPostsRes: requestLiked ? LOADING_REQUEST : EMPTY_REQUEST,
          uploadsRes: EMPTY_REQUEST,
        });
      }
    }

    const client = HttpService.client;

    const personFetch = client.getPersonDetails({
      username: props.match.params.username,
      sort,
      saved_only: view === PersonDetailsView.Saved,
      page,
      limit: fetchLimit,
    });

    let likedCommentsFetch: Promise<RequestState<GetCommentsResponse>> =
      Promise.resolve(EMPTY_REQUEST);
    let likedPostsFetch: Promise<RequestState<GetPostsResponse>> =
      Promise.resolve(EMPTY_REQUEST);

    if (requestLiked) {
      const likedCommentsForm: GetComments = {
        page,
        limit: fetchLimit,
        type_: "All",
        sort: postToCommentSortType(sort),
        liked_only: true,
      };
      likedCommentsFetch = client.getComments(likedCommentsForm);

      const likedPostsForm: GetPosts = {
        page,
        limit: fetchLimit,
        type_: "All",
        sort,
        liked_only: true,
        show_read: true,
      };
      likedPostsFetch = client.getPosts(likedPostsForm);
    }

    const [personRes, likedCommentsRes, likedPostsRes] = await Promise.all([
      personFetch,
      likedCommentsFetch,
      likedPostsFetch,
    ]);

    if (token === this.fetchUserDataToken) {
      this.setState({
        personRes,
        personDetailsRes: personRes,
        personBlocked: isPersonBlocked(personRes),
        likedCommentsRes,
        likedPostsRes,
      });
    }
  }

  get amCurrentUser() {
    if (this.state.personRes.state === "success") {
      return (
        UserService.Instance.myUserInfo?.local_user_view.person.id ===
        this.state.personRes.data.person_view.person.id
      );
    } else {
      return false;
    }
  }

  static async fetchInitialData({
    headers,
    query: { view, sort, page },
    match: {
      params: { username },
    },
  }: InitialFetchRequest<
    ProfilePathProps,
    ProfileProps
  >): Promise<ProfileData> {
    const client = wrapClient(
      new LemmyHttp(getHttpBaseInternal(), { headers }),
    );

    let uploadsRes: RequestState<ListMediaResponse> = EMPTY_REQUEST;

    if (view === PersonDetailsView.Uploads) {
      const form: ListMedia = {
        page,
        limit: fetchLimit,
      };
      uploadsRes = await client.listMedia(form);
    }

    const form: GetPersonDetails = {
      username: username,
      sort,
      saved_only: view === PersonDetailsView.Saved,
      page,
      limit: fetchLimit,
    };
    const personFetch = client.getPersonDetails(form);

    let likedCommentsFetch: Promise<RequestState<GetCommentsResponse>> =
      Promise.resolve(EMPTY_REQUEST);
    let likedPostsFetch: Promise<RequestState<GetPostsResponse>> =
      Promise.resolve(EMPTY_REQUEST);

    if (view === PersonDetailsView.Upvoted) {
      const likedCommentsForm: GetComments = {
        page,
        limit: fetchLimit,
        type_: "All",
        sort: postToCommentSortType(sort),
        liked_only: true,
      };
      likedCommentsFetch = client.getComments(likedCommentsForm);

      const likedPostsForm: GetPosts = {
        page,
        limit: fetchLimit,
        type_: "All",
        sort,
        liked_only: true,
        show_read: true,
      };
      likedPostsFetch = client.getPosts(likedPostsForm);
    }

    const [personRes, likedCommentsRes, likedPostsRes] = await Promise.all([
      personFetch,
      likedCommentsFetch,
      likedPostsFetch,
    ]);

    return {
      personRes,
      likedCommentsRes,
      likedPostsRes,
      uploadsRes,
    };
  }

  get documentTitle(): string {
    const siteName = this.state.siteRes.site_view.site.name;
    const res = this.state.personRes;
    return res.state === "success"
      ? `@${res.data.person_view.person.name} - ${siteName}`
      : siteName;
  }

  renderUploadsRes() {
    switch (this.state.uploadsRes.state) {
      case "loading":
        return (
          <h5>
            <Spinner large />
          </h5>
        );
      case "success": {
        const uploadsRes = this.state.uploadsRes.data;
        return (
          <div>
            <MediaUploads uploads={uploadsRes} />
          </div>
        );
      }
    }
  }

  renderPersonRes() {
    switch (this.state.personRes.state) {
      case "loading":
        return (
          <h5>
            <Spinner large />
          </h5>
        );
      case "success": {
        const siteRes = this.state.siteRes;
        const personRes = this.state.personRes.data;
        const { page, sort, view } = this.props;

        const personDetailsState = this.state.personDetailsRes.state;
        const personDetailsRes =
          personDetailsState === "success" && this.state.personDetailsRes.data;

        const likedCommentsState = this.state.likedCommentsRes.state;
        const likedCommentsRes =
          likedCommentsState === "success"
            ? this.state.likedCommentsRes.data
            : undefined;

        const likedPostsState = this.state.likedPostsRes.state;
        const likedPostsRes =
          likedPostsState === "success"
            ? this.state.likedPostsRes.data
            : undefined;

        return (
          <div className="row">
            <div className="col-12 col-md-8">
              <HtmlTags
                title={this.documentTitle}
                path={this.context.router.route.match.url}
                canonicalPath={personRes.person_view.person.actor_id}
                description={personRes.person_view.person.bio}
                image={personRes.person_view.person.avatar}
              />

              {this.userInfo(personRes.person_view)}

              <hr />

              {this.selects}

              {this.renderUploadsRes()}

              {(personDetailsState === "loading" ||
                likedCommentsState === "loading" ||
                likedPostsState === "loading") &&
              this.props.view !== PersonDetailsView.Uploads ? (
                <h5>
                  <Spinner large />
                </h5>
              ) : (
                personDetailsRes && (
                  <PersonDetails
                    personRes={personDetailsRes}
                    likedCommentsRes={likedCommentsRes}
                    likedPostsRes={likedPostsRes}
                    admins={siteRes.admins}
                    sort={sort}
                    page={page}
                    limit={fetchLimit}
                    enableDownvotes={enableDownvotes(siteRes)}
                    voteDisplayMode={voteDisplayMode(siteRes)}
                    enableNsfw={enableNsfw(siteRes)}
                    view={view}
                    onPageChange={this.handlePageChange}
                    allLanguages={siteRes.all_languages}
                    siteLanguages={siteRes.discussion_languages}
                    // TODO all the forms here
                    onSaveComment={this.handleSaveComment}
                    onBlockPerson={this.handleBlockPersonAlt}
                    onDeleteComment={this.handleDeleteComment}
                    onRemoveComment={this.handleRemoveComment}
                    onCommentVote={this.handleCommentVote}
                    onCommentReport={this.handleCommentReport}
                    onDistinguishComment={this.handleDistinguishComment}
                    onAddModToCommunity={this.handleAddModToCommunity}
                    onAddAdmin={this.handleAddAdmin}
                    onTransferCommunity={this.handleTransferCommunity}
                    onPurgeComment={this.handlePurgeComment}
                    onPurgePerson={this.handlePurgePerson}
                    onCommentReplyRead={this.handleCommentReplyRead}
                    onPersonMentionRead={this.handlePersonMentionRead}
                    onBanPersonFromCommunity={this.handleBanFromCommunity}
                    onBanPerson={this.handleBanPerson}
                    onCreateComment={this.handleCreateComment}
                    onEditComment={this.handleEditComment}
                    onPostEdit={this.handlePostEdit}
                    onPostVote={this.handlePostVote}
                    onPostReport={this.handlePostReport}
                    onLockPost={this.handleLockPost}
                    onDeletePost={this.handleDeletePost}
                    onRemovePost={this.handleRemovePost}
                    onSavePost={this.handleSavePost}
                    onPurgePost={this.handlePurgePost}
                    onFeaturePost={this.handleFeaturePost}
                    onMarkPostAsRead={() => {}}
                  />
                )
              )}
            </div>

            <div className="col-12 col-md-4">
              <Moderates moderates={personRes.moderates} />
              {this.amCurrentUser && <Follows />}
            </div>
          </div>
        );
      }
    }
  }

  render() {
    return (
      <div className="person-profile container-lg">
        {this.renderPersonRes()}
      </div>
    );
  }

  get viewRadios() {
    return (
      <div className="btn-group btn-group-toggle flex-wrap" role="group">
        {this.getRadio(PersonDetailsView.Overview)}
        {this.getRadio(PersonDetailsView.Comments)}
        {this.getRadio(PersonDetailsView.Posts)}
        {this.amCurrentUser && this.getRadio(PersonDetailsView.Saved)}
        {this.amCurrentUser && this.getRadio(PersonDetailsView.Uploads)}
        {this.amCurrentUser && this.getRadio(PersonDetailsView.Upvoted)}
      </div>
    );
  }

  getRadio(view: PersonDetailsView) {
    const { view: urlView } = this.props;
    const active = view === urlView;
    const radioId = randomStr();

    return (
      <>
        <input
          id={radioId}
          type="radio"
          className="btn-check"
          value={view}
          checked={active}
          onChange={linkEvent(this, this.handleViewChange)}
        />
        <label
          htmlFor={radioId}
          className={classNames("btn btn-outline-secondary pointer", {
            active,
          })}
        >
          {I18NextService.i18n.t(view.toLowerCase() as NoOptionI18nKeys)}
        </label>
      </>
    );
  }

  get selects() {
    const { sort, view } = this.props;
    const { username } = this.props.match.params;

    const profileRss = `/feeds/u/${username}.xml${getQueryString({ sort })}`;

    return (
      <div className="row align-items-center mb-3 g-3">
        <div className="col-auto">{this.viewRadios}</div>
        <div className="col-auto">
          <SortSelect
            sort={sort}
            onChange={this.handleSortChange}
            hideHot
            hideMostComments
          />
        </div>
        {/* Don't show the rss feed for the Saved, Uploads, and Upvoted view, as that's not implemented.*/}
        {view !== PersonDetailsView.Saved &&
          view !== PersonDetailsView.Uploads &&
          view !== PersonDetailsView.Upvoted && (
            <div className="col-auto">
              <a href={profileRss} rel={relTags} title="RSS">
                <Icon icon="rss" classes="text-muted small ps-0" />
              </a>
              <link
                rel="alternate"
                type="application/atom+xml"
                href={profileRss}
              />
            </div>
          )}
      </div>
    );
  }

  userInfo(pv: PersonView) {
    const {
      personBlocked,
      siteRes: { admins },
      showBanDialog,
      showRegistrationDialog,
      registrationRes,
    } = this.state;

    return (
      pv && (
        <div>
          {!pv.person.banned && (
            <BannerIconHeader
              banner={pv.person.banner}
              icon={pv.person.avatar}
            />
          )}
          <div className="mb-3">
            <div className="">
              <div className="mb-0 d-flex flex-wrap">
                <div>
                  {pv.person.display_name && (
                    <h1 className="h4 mb-4">{pv.person.display_name}</h1>
                  )}
                  <ul className="list-inline mb-2">
                    <li className="list-inline-item">
                      <PersonListing
                        person={pv.person}
                        realLink
                        useApubName
                        muted
                        hideAvatar
                      />
                    </li>
                    <li className="list-inline-item">
                      <UserBadges
                        classNames="ms-1"
                        isBanned={pv.person.banned}
                        isDeleted={pv.person.deleted}
                        isAdmin={pv.is_admin}
                        isBot={pv.person.bot_account}
                      />
                    </li>
                  </ul>
                </div>
                {this.banDialog(pv)}
                <div className="flex-grow-1 unselectable pointer mx-2"></div>
                {!this.amCurrentUser && UserService.Instance.myUserInfo && (
                  <>
                    {amAdmin() && (
                      <Link
                        className={
                          "d-flex align-self-start btn btn-secondary me-2"
                        }
                        to={`/modlog?userId=${pv.person.id}`}
                      >
                        {I18NextService.i18n.t("user_moderation_history", {
                          user: pv.person.name,
                        })}
                      </Link>
                    )}
                    {pv.person.matrix_user_id && (
                      <a
                        className={`d-flex align-self-start btn btn-secondary me-2`}
                        rel={relTags}
                        href={`https://matrix.to/#/${pv.person.matrix_user_id}`}
                      >
                        {I18NextService.i18n.t("send_secure_message")}
                      </a>
                    )}
                    <Link
                      className={
                        "d-flex align-self-start btn btn-secondary me-2"
                      }
                      to={`/create_private_message/${pv.person.id}`}
                    >
                      {I18NextService.i18n.t("send_message")}
                    </Link>
                    {personBlocked ? (
                      <button
                        className={
                          "d-flex align-self-start btn btn-secondary me-2"
                        }
                        onClick={linkEvent(
                          pv.person.id,
                          this.handleUnblockPerson,
                        )}
                      >
                        {I18NextService.i18n.t("unblock_user")}
                      </button>
                    ) : (
                      <button
                        className={
                          "d-flex align-self-start btn btn-secondary me-2"
                        }
                        onClick={linkEvent(
                          pv.person.id,
                          this.handleBlockPerson,
                        )}
                      >
                        {I18NextService.i18n.t("block_user")}
                      </button>
                    )}
                  </>
                )}

                {canMod(pv.person.id, undefined, admins) &&
                  !pv.is_admin &&
                  !showBanDialog &&
                  (!pv.person.banned ? (
                    <button
                      className={
                        "d-flex align-self-start btn btn-secondary me-2"
                      }
                      onClick={linkEvent(this, this.handleModBanShow)}
                      aria-label={I18NextService.i18n.t("ban")}
                    >
                      {capitalizeFirstLetter(I18NextService.i18n.t("ban"))}
                    </button>
                  ) : (
                    <button
                      className={
                        "d-flex align-self-start btn btn-secondary me-2"
                      }
                      onClick={linkEvent(this, this.handleModBanSubmit)}
                      aria-label={I18NextService.i18n.t("unban")}
                    >
                      {capitalizeFirstLetter(I18NextService.i18n.t("unban"))}
                    </button>
                  ))}
                {amAdmin() && pv.person.local && (
                  <>
                    <button
                      className={
                        "d-flex registration-self-start btn btn-secondary me-2"
                      }
                      aria-label={I18NextService.i18n.t("view_registration")}
                      onClick={this.handleRegistrationShow}
                    >
                      {I18NextService.i18n.t("view_registration")}
                    </button>
                    {showRegistrationDialog && (
                      <DisplayModal
                        onClose={this.handleRegistrationClose}
                        loadingMessage={I18NextService.i18n.t(
                          "loading_registration",
                        )}
                        title={I18NextService.i18n.t("registration_for_user", {
                          name: pv.person.display_name ?? pv.person.name,
                        })}
                        show={showRegistrationDialog}
                        loading={registrationRes.state === "loading"}
                      >
                        {registrationRes.state === "success" ? (
                          <article
                            dangerouslySetInnerHTML={mdToHtml(
                              registrationRes.data.registration_application
                                .registration_application.answer,
                              () => this.forceUpdate(),
                            )}
                          />
                        ) : registrationRes.state === "failed" ? (
                          I18NextService.i18n.t("fetch_registration_error")
                        ) : (
                          ""
                        )}
                      </DisplayModal>
                    )}
                  </>
                )}
              </div>
              {pv.person.bio && (
                <div className="d-flex align-items-center mb-2">
                  <div
                    className="md-div"
                    dangerouslySetInnerHTML={mdToHtml(pv.person.bio, () =>
                      this.forceUpdate(),
                    )}
                  />
                </div>
              )}
              <div>
                <ul className="list-inline mb-2">
                  <li className="list-inline-item badge text-bg-light">
                    {I18NextService.i18n.t("number_of_posts", {
                      count: Number(pv.counts.post_count),
                      formattedCount: numToSI(pv.counts.post_count),
                    })}
                  </li>
                  <li className="list-inline-item badge text-bg-light">
                    {I18NextService.i18n.t("number_of_comments", {
                      count: Number(pv.counts.comment_count),
                      formattedCount: numToSI(pv.counts.comment_count),
                    })}
                  </li>
                </ul>
              </div>
              <div className="text-muted">
                {I18NextService.i18n.t("joined")}{" "}
                <MomentTime
                  published={pv.person.published}
                  showAgo
                  ignoreUpdated
                />
              </div>
              <div className="d-flex align-items-center text-muted mb-2">
                <Icon icon="cake" />
                <span className="ms-2">
                  {I18NextService.i18n.t("cake_day_title")}{" "}
                  {format(cakeDate(pv.person.published), "PPP")}
                </span>
              </div>
              {!UserService.Instance.myUserInfo && (
                <div className="alert alert-info" role="alert">
                  {I18NextService.i18n.t("profile_not_logged_in_alert")}
                </div>
              )}
            </div>
          </div>
        </div>
      )
    );
  }

  banDialog(pv: PersonView) {
    const { showBanDialog } = this.state;

    return (
      showBanDialog && (
        <form onSubmit={linkEvent(this, this.handleModBanSubmit)}>
          <div className="mb-3 row col-12">
            <label className="col-form-label" htmlFor="profile-ban-reason">
              {I18NextService.i18n.t("reason")}
            </label>
            <input
              type="text"
              id="profile-ban-reason"
              className="form-control me-2"
              placeholder={I18NextService.i18n.t("reason")}
              value={this.state.banReason}
              onInput={linkEvent(this, this.handleModBanReasonChange)}
            />
            <label className="col-form-label" htmlFor="mod-ban-expires">
              {I18NextService.i18n.t("expires")}
            </label>
            <input
              type="number"
              id="mod-ban-expires"
              className="form-control me-2"
              placeholder={I18NextService.i18n.t("number_of_days")}
              value={this.state.banExpireDays}
              onInput={linkEvent(this, this.handleModBanExpireDaysChange)}
            />
            <div className="input-group mb-3">
              <div className="form-check">
                <input
                  className="form-check-input"
                  id="mod-ban-remove-data"
                  type="checkbox"
                  checked={this.state.removeOrRestoreData}
                  onChange={linkEvent(this, this.handleModRemoveDataChange)}
                />
                <label
                  className="form-check-label"
                  htmlFor="mod-ban-remove-data"
                  title={I18NextService.i18n.t("remove_content_more")}
                >
                  {I18NextService.i18n.t("remove_content")}
                </label>
              </div>
            </div>
          </div>
          {/* TODO hold off on expires until later */}
          {/* <div class="mb-3 row"> */}
          {/*   <label class="col-form-label">Expires</label> */}
          {/*   <input type="date" class="form-control me-2" placeholder={I18NextService.i18n.t('expires')} value={this.state.banExpires} onInput={linkEvent(this, this.handleModBanExpiresChange)} /> */}
          {/* </div> */}
          <div className="mb-3 row">
            <button
              type="reset"
              className="btn btn-secondary me-2"
              aria-label={I18NextService.i18n.t("cancel")}
              onClick={linkEvent(this, this.handleModBanSubmitCancel)}
            >
              {I18NextService.i18n.t("cancel")}
            </button>
          </div>
          <div className="mb-3 row">
            <button
              type="submit"
              className="btn btn-secondary"
              aria-label={I18NextService.i18n.t("ban")}
            >
              {I18NextService.i18n.t("ban")} {pv.person.name}
            </button>
          </div>
        </form>
      )
    );
  }

  async updateUrl(props: Partial<ProfileRouteProps>) {
    const {
      page,
      sort,
      view,
      match: {
        params: { username },
      },
    } = { ...this.props, ...props };

    const queryParams: QueryParams<ProfileProps> = {
      page: page?.toString(),
      sort,
      view,
    };

    this.props.history.push(`/u/${username}${getQueryString(queryParams)}`);
  }

  handlePageChange(page: number) {
    this.updateUrl({ page });
  }

  handleSortChange(sort: PostSortType) {
    this.updateUrl({ sort, page: 1 });
  }

  handleViewChange(i: Profile, event: any) {
    i.updateUrl({
      view: PersonDetailsView[event.target.value],
      page: 1,
    });
  }

  handleModBanShow(i: Profile) {
    i.setState({ showBanDialog: true });
  }

  handleModBanReasonChange(i: Profile, event: any) {
    i.setState({ banReason: event.target.value });
  }

  handleModBanExpireDaysChange(i: Profile, event: any) {
    i.setState({ banExpireDays: event.target.value });
  }

  handleModRemoveDataChange(i: Profile, event: any) {
    i.setState({ removeOrRestoreData: event.target.checked });
  }

  handleModBanSubmitCancel(i: Profile) {
    i.setState({ showBanDialog: false });
  }

  handleRegistrationShow() {
    if (this.state.registrationRes.state !== "success") {
      this.setState({ registrationRes: LOADING_REQUEST });
    }

    this.setState({ showRegistrationDialog: true });

    if (this.state.personDetailsRes.state === "success") {
      HttpService.client
        .getRegistrationApplication({
          person_id: this.state.personDetailsRes.data.person_view.person.id,
        })
        .then(res => {
          this.setState({ registrationRes: res });

          if (res.state === "failed") {
            toast(I18NextService.i18n.t("fetch_registration_error"), "danger");
          }
        });
    }
  }

  handleRegistrationClose() {
    this.setState({ showRegistrationDialog: false });
  }

  async handleModBanSubmit(i: Profile, event: any) {
    event.preventDefault();
    const { banReason, banExpireDays } = i.state;

    const personRes = i.state.personRes;

    if (personRes.state === "success") {
      const person = personRes.data.person_view.person;
      const ban = !person.banned;

      // If its an unban, restore all their data
      if (!ban) {
        i.setState({ removeOrRestoreData: true });
      }

      const res = await HttpService.client.banPerson({
        person_id: person.id,
        ban,
        remove_or_restore_data: i.state.removeOrRestoreData,
        reason: banReason,
        expires: futureDaysToUnixTime(banExpireDays),
      });
      // TODO
      this.updateBan(res);
      i.setState({ showBanDialog: false });
    }
  }

  async toggleBlockPerson(recipientId: number, block: boolean) {
    const res = await HttpService.client.blockPerson({
      person_id: recipientId,
      block,
    });
    if (res.state === "success") {
      updatePersonBlock(res.data);
      this.setState({ personBlocked: res.data.blocked });
    }
  }

  handleUnblockPerson(personId: number) {
    this.toggleBlockPerson(personId, false);
  }

  handleBlockPerson(personId: number) {
    this.toggleBlockPerson(personId, true);
  }

  async handleAddModToCommunity(form: AddModToCommunity) {
    // TODO not sure what to do here
    await HttpService.client.addModToCommunity(form);
  }

  async handlePurgePerson(form: PurgePerson) {
    const purgePersonRes = await HttpService.client.purgePerson(form);
    this.purgeItem(purgePersonRes);
  }

  async handlePurgeComment(form: PurgeComment) {
    const purgeCommentRes = await HttpService.client.purgeComment(form);
    this.purgeItem(purgeCommentRes);
  }

  async handlePurgePost(form: PurgePost) {
    const purgeRes = await HttpService.client.purgePost(form);
    this.purgeItem(purgeRes);
  }

  async handleBlockPersonAlt(form: BlockPerson) {
    const blockPersonRes = await HttpService.client.blockPerson(form);
    if (blockPersonRes.state === "success") {
      updatePersonBlock(blockPersonRes.data);
      this.setState({ personBlocked: blockPersonRes.data.blocked });
    }
  }

  async handleCreateComment(form: CreateComment) {
    const createCommentRes = await HttpService.client.createComment(form);
    this.createAndUpdateComments(createCommentRes);

    return createCommentRes;
  }

  async handleEditComment(form: EditComment) {
    const editCommentRes = await HttpService.client.editComment(form);
    this.findAndUpdateCommentEdit(editCommentRes);

    return editCommentRes;
  }

  async handleDeleteComment(form: DeleteComment) {
    const deleteCommentRes = await HttpService.client.deleteComment(form);
    this.findAndUpdateComment(deleteCommentRes);
  }

  async handleDeletePost(form: DeletePost) {
    const deleteRes = await HttpService.client.deletePost(form);
    this.findAndUpdatePost(deleteRes);
  }

  async handleRemovePost(form: RemovePost) {
    const removeRes = await HttpService.client.removePost(form);
    this.findAndUpdatePost(removeRes);
  }

  async handleRemoveComment(form: RemoveComment) {
    const removeCommentRes = await HttpService.client.removeComment(form);
    this.findAndUpdateComment(removeCommentRes);
  }

  async handleSaveComment(form: SaveComment) {
    const saveCommentRes = await HttpService.client.saveComment(form);
    this.findAndUpdateComment(saveCommentRes);
  }

  async handleSavePost(form: SavePost) {
    const saveRes = await HttpService.client.savePost(form);
    this.findAndUpdatePost(saveRes);
  }

  async handleFeaturePost(form: FeaturePost) {
    const featureRes = await HttpService.client.featurePost(form);
    this.findAndUpdatePost(featureRes);
  }

  async handleCommentVote(form: CreateCommentLike) {
    const voteRes = await HttpService.client.likeComment(form);
    this.findAndUpdateComment(voteRes);
  }

  async handlePostVote(form: CreatePostLike) {
    const voteRes = await HttpService.client.likePost(form);
    this.findAndUpdatePost(voteRes);
    return voteRes;
  }

  async handlePostEdit(form: EditPost) {
    const res = await HttpService.client.editPost(form);
    this.findAndUpdatePost(res);
    return res;
  }

  async handleCommentReport(form: CreateCommentReport) {
    const reportRes = await HttpService.client.createCommentReport(form);
    if (reportRes.state === "success") {
      toast(I18NextService.i18n.t("report_created"));
    }
  }

  async handlePostReport(form: CreatePostReport) {
    const reportRes = await HttpService.client.createPostReport(form);
    if (reportRes.state === "success") {
      toast(I18NextService.i18n.t("report_created"));
    }
  }

  async handleLockPost(form: LockPost) {
    const lockRes = await HttpService.client.lockPost(form);
    this.findAndUpdatePost(lockRes);
  }

  async handleDistinguishComment(form: DistinguishComment) {
    const distinguishRes = await HttpService.client.distinguishComment(form);
    this.findAndUpdateComment(distinguishRes);
  }

  async handleAddAdmin(form: AddAdmin) {
    const addAdminRes = await HttpService.client.addAdmin(form);

    if (addAdminRes.state === "success") {
      this.setState(s => ((s.siteRes.admins = addAdminRes.data.admins), s));
    }
  }

  async handleTransferCommunity(form: TransferCommunity) {
    await HttpService.client.transferCommunity(form);
    toast(I18NextService.i18n.t("transfer_community"));
  }

  async handleCommentReplyRead(form: MarkCommentReplyAsRead) {
    const readRes = await HttpService.client.markCommentReplyAsRead(form);
    this.findAndUpdateCommentReply(readRes);
  }

  async handlePersonMentionRead(form: MarkPersonMentionAsRead) {
    // TODO not sure what to do here. Maybe it is actually optional, because post doesn't need it.
    await HttpService.client.markPersonMentionAsRead(form);
  }

  async handleBanFromCommunity(form: BanFromCommunity) {
    const banRes = await HttpService.client.banFromCommunity(form);
    this.updateBanFromCommunity(banRes);
  }

  async handleBanPerson(form: BanPerson) {
    const banRes = await HttpService.client.banPerson(form);
    this.updateBan(banRes);
  }

  updateBanFromCommunity(banRes: RequestState<BanFromCommunityResponse>) {
    // Maybe not necessary
    if (banRes.state === "success") {
      this.setState(s => {
        if (s.personRes.state === "success") {
          s.personRes.data.posts
            .filter(c => c.creator.id === banRes.data.person_view.person.id)
            .forEach(
              c => (c.creator_banned_from_community = banRes.data.banned),
            );

          s.personRes.data.comments
            .filter(c => c.creator.id === banRes.data.person_view.person.id)
            .forEach(
              c => (c.creator_banned_from_community = banRes.data.banned),
            );
        }
        return s;
      });
    }
  }

  updateBan(banRes: RequestState<BanPersonResponse>) {
    // Maybe not necessary
    if (banRes.state === "success") {
      this.setState(s => {
        if (s.personRes.state === "success") {
          s.personRes.data.posts
            .filter(c => c.creator.id === banRes.data.person_view.person.id)
            .forEach(c => (c.creator.banned = banRes.data.banned));
          s.personRes.data.comments
            .filter(c => c.creator.id === banRes.data.person_view.person.id)
            .forEach(c => (c.creator.banned = banRes.data.banned));
          s.personRes.data.person_view.person.banned = banRes.data.banned;
        }
        return s;
      });
    }
  }

  purgeItem(purgeRes: RequestState<SuccessResponse>) {
    if (purgeRes.state === "success") {
      toast(I18NextService.i18n.t("purge_success"));
      this.context.router.history.push(`/`);
    }
  }

  findAndUpdateCommentEdit(res: RequestState<CommentResponse>) {
    this.setState(s => {
      if (s.personRes.state === "success" && res.state === "success") {
        s.personRes.data.comments = editComment(
          res.data.comment_view,
          s.personRes.data.comments,
        );
      }
      return s;
    });
  }

  findAndUpdateComment(res: RequestState<CommentResponse>) {
    this.setState(s => {
      if (s.personRes.state === "success" && res.state === "success") {
        s.personRes.data.comments = editComment(
          res.data.comment_view,
          s.personRes.data.comments,
        );
      }
      return s;
    });
  }

  createAndUpdateComments(res: RequestState<CommentResponse>) {
    this.setState(s => {
      if (s.personRes.state === "success" && res.state === "success") {
        s.personRes.data.comments.unshift(res.data.comment_view);
      }
      return s;
    });
  }

  findAndUpdateCommentReply(res: RequestState<CommentReplyResponse>) {
    this.setState(s => {
      if (s.personRes.state === "success" && res.state === "success") {
        s.personRes.data.comments = editWith(
          res.data.comment_reply_view,
          s.personRes.data.comments,
        );
      }
      return s;
    });
  }

  findAndUpdatePost(res: RequestState<PostResponse>) {
    this.setState(s => {
      if (s.personRes.state === "success" && res.state === "success") {
        s.personRes.data.posts = editPost(
          res.data.post_view,
          s.personRes.data.posts,
        );
      }
      return s;
    });
  }
}
