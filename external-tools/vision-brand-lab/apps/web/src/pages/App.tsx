import { UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  ConfigProvider,
  Empty,
  Image,
  Input,
  Layout,
  List,
  Menu,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useRef, useState } from 'react';
import type {
  BrandAssociationResult,
  UploadedImageRef,
  VisionBrandAnalyzeResult,
  VisualReviewerResult,
} from '@vision-brand-lab/core';
import { analyze, uploadImage } from '../lib/api.js';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

const roundScore = (r: VisualReviewerResult) =>
  r.overallScore ?? Math.round((r.score ?? 0) * 10);

export const App = () => {
  const [designImage, setDesignImage] = useState<UploadedImageRef>();
  const [brandImage, setBrandImage] = useState<UploadedImageRef>();
  const [designPreview, setDesignPreview] = useState<string>();
  const [brandPreview, setBrandPreview] = useState<string>();
  const [goal, setGoal] = useState('评估设计视觉清晰度、转化动线与品牌一致性');
  const [result, setResult] = useState<VisionBrandAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const designInputRef = useRef<HTMLInputElement>(null);
  const brandInputRef = useRef<HTMLInputElement>(null);

  const upload = async (
    file: File | undefined,
    setRef: (v: UploadedImageRef) => void,
    setPreview: (v: string) => void,
  ) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(URL.createObjectURL(file));
      setRef(await uploadImage(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await analyze({
          designImages: designImage ? [designImage] : [],
          brandReferenceImages: brandImage ? [brandImage] : [],
          businessGoal: goal,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const vr = result?.visualReview;
  const ba = result?.brandAssociation;
  const reviewers = vr?.reviewers ?? [];
  const consensus = vr?.consensus ?? [];
  const conflicts = vr?.conflicts ?? [];
  const priorityActions = vr?.priorityActions ?? [];
  const modelTags = Array.from(
    new Set(reviewers.map((r) => r.actualModel).filter((m): m is string => Boolean(m))),
  );
  const enginePill =
    result?.engine === 'vlm'
      ? '真实 VLM'
      : result?.engine === 'heuristic'
        ? '启发式降级'
        : undefined;

  return (
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 14, colorPrimary: '#1677ff' } }}>
      <Layout className="app-shell">
        <Sider width={240} theme="light" className="app-shell-sider">
          <div className="app-shell-brand">
            <div className="app-shell-brand-kicker">Research OS</div>
            <div className="app-shell-brand-title">AI 用研分析系统</div>
          </div>
          <Menu
            selectedKeys={['vision']}
            mode="inline"
            items={[{ key: 'vision', label: '视觉评审' }]}
          />
        </Sider>
        <Layout className="app-shell-main">
          <Header className="app-shell-header">
            <div className="app-shell-header-kicker">Workspace</div>
            <div className="app-shell-header-title">视觉评审</div>
            <div className="app-shell-header-subtitle">
              上传设计稿与品牌参考图，由 VLM 多角色评审 + 品牌联想度分析
            </div>
          </Header>
          <Content className="app-shell-content">
            <div className="app-shell-content-inner">
              {/* ---------- 操作区 ---------- */}
              <Card className="page-card" title="发起评审">
                <Space direction="vertical" size={18} style={{ width: '100%' }}>
                  <div className="lab-uploader-grid">
                    <div className="lab-uploader">
                      <Text className="experience-cell-label">设计稿 *</Text>
                      {designPreview ? (
                        <img className="lab-uploader-preview" src={designPreview} alt="设计稿预览" />
                      ) : null}
                      <div>
                        <Button
                          icon={<UploadOutlined />}
                          onClick={() => designInputRef.current?.click()}
                        >
                          上传设计稿
                        </Button>
                      </div>
                      <input
                        ref={designInputRef}
                        hidden
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          void upload(e.target.files?.[0], setDesignImage, setDesignPreview);
                          e.currentTarget.value = '';
                        }}
                      />
                    </div>
                    <div className="lab-uploader">
                      <Text className="experience-cell-label">品牌参考图（可选，做品牌联想度）</Text>
                      {brandPreview ? (
                        <img className="lab-uploader-preview" src={brandPreview} alt="品牌参考图预览" />
                      ) : null}
                      <div>
                        <Button
                          icon={<UploadOutlined />}
                          onClick={() => brandInputRef.current?.click()}
                        >
                          上传品牌参考图
                        </Button>
                      </div>
                      <input
                        ref={brandInputRef}
                        hidden
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          void upload(e.target.files?.[0], setBrandImage, setBrandPreview);
                          e.currentTarget.value = '';
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <Text className="experience-cell-label">业务目标</Text>
                    <Input.TextArea
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      rows={2}
                      placeholder="例如：评估设计视觉清晰度、转化动线与品牌一致性"
                    />
                  </div>

                  <Button
                    type="primary"
                    size="large"
                    loading={busy}
                    disabled={!designImage}
                    onClick={() => void run()}
                  >
                    开始评审
                  </Button>
                </Space>
              </Card>

              {error ? <Alert type="error" showIcon message="分析失败" description={error} /> : null}

              {/* ---------- 结果区 ---------- */}
              {result ? (
                <>
                  <div className="module-hero module-hero-vision">
                    <div className="module-hero-main">
                      <Text className="module-hero-kicker">Vision Review</Text>
                      <Title level={2} className="module-hero-title">
                        视觉评审
                      </Title>
                      <Paragraph className="module-hero-description">
                        查看角色分工、共识、冲突，以及当前最高优先级的视觉动作。
                      </Paragraph>
                      <div className="module-hero-meta">
                        <Text className="module-hero-pill">多角色并行评审</Text>
                        <Text className="module-hero-pill">共识 / 冲突归纳</Text>
                        {enginePill ? <Text className="module-hero-pill">{enginePill}</Text> : null}
                      </div>
                    </div>
                  </div>

                  {priorityActions[0] ? (
                    <Card className="page-card module-toolbar-card">
                      <div className="vision-toolbar-layout">
                        <div className="vision-toolbar-priority-callout">
                          <Text className="vision-toolbar-priority-label">当前最高优先动作</Text>
                          <Text className="vision-toolbar-priority-text">{priorityActions[0]}</Text>
                        </div>
                      </div>
                    </Card>
                  ) : null}

                  {goal ? (
                    <Card title="本模块任务" className="page-card module-section-card">
                      <div className="vision-briefing-card">
                        <div className="vision-briefing-block vision-briefing-highlight">
                          <Text className="experience-cell-label">业务目标</Text>
                          <Paragraph className="vision-briefing-text">{goal}</Paragraph>
                        </div>
                      </div>
                    </Card>
                  ) : null}

                  {vr ? (
                    <>
                      <div className="vision-top-grid">
                        <Card
                          title="测试视觉稿件预览"
                          className="page-card module-section-card vision-preview-card"
                        >
                          {designPreview ? (
                            <div className="vision-preview-frame">
                              <Image src={designPreview} alt="测试视觉稿件" className="vision-preview-image" />
                            </div>
                          ) : (
                            <Empty
                              image={Empty.PRESENTED_IMAGE_SIMPLE}
                              description="当前没有可预览的设计稿"
                            />
                          )}
                        </Card>

                        <Card title="共识问题" className="page-card module-section-card">
                          {consensus.length ? (
                            <List
                              dataSource={consensus}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          ) : (
                            <Empty
                              image={Empty.PRESENTED_IMAGE_SIMPLE}
                              description="当前没有形成稳定共识"
                            />
                          )}
                        </Card>
                      </div>

                      <div className="vision-summary-grid">
                        <Card title="执行概览" className="page-card module-section-card">
                          <Space direction="vertical" size={12} style={{ width: '100%' }}>
                            <div className="vision-stat-row">
                              <div className="vision-stat-card">
                                <Text className="experience-cell-label">参与模型</Text>
                                <Text strong>{modelTags.length}</Text>
                              </div>
                              <div className="vision-stat-card">
                                <Text className="experience-cell-label">共识数量</Text>
                                <Text strong>{consensus.length}</Text>
                              </div>
                              <div className="vision-stat-card">
                                <Text className="experience-cell-label">冲突数量</Text>
                                <Text strong>{conflicts.length}</Text>
                              </div>
                            </div>
                            {modelTags.length ? (
                              <Space wrap>
                                {modelTags.map((model) => (
                                  <Tag color="blue" key={model}>
                                    {model}
                                  </Tag>
                                ))}
                              </Space>
                            ) : null}
                          </Space>
                        </Card>

                        <Card title="最高优先级动作" className="page-card module-section-card">
                          {priorityActions.length ? (
                            <List
                              size="small"
                              dataSource={priorityActions}
                              renderItem={(item, index) => (
                                <List.Item>
                                  <div className="vision-priority-item">
                                    <div className="vision-priority-index">{index + 1}</div>
                                    <Text>{item}</Text>
                                  </div>
                                </List.Item>
                              )}
                            />
                          ) : (
                            <Empty
                              image={Empty.PRESENTED_IMAGE_SIMPLE}
                              description="当前没有明确的优先动作"
                            />
                          )}
                        </Card>
                      </div>
                    </>
                  ) : null}

                  {reviewers.length ? (
                    <Card title="角色评审明细" className="page-card module-section-card">
                      <div className="vision-reviewer-grid">
                        {reviewers.map((reviewer) => (
                          <ReviewerCard key={reviewer.role} reviewer={reviewer} />
                        ))}
                      </div>
                    </Card>
                  ) : null}

                  {conflicts.length ? (
                    <Card title="冲突主题" className="page-card module-section-card">
                      <List
                        size="small"
                        dataSource={conflicts}
                        renderItem={(item) => <List.Item>{item}</List.Item>}
                      />
                    </Card>
                  ) : null}

                  {ba ? <BrandCard ba={ba} /> : null}

                  {result.boundaryNotes.length || result.warnings.length ? (
                    <Row gutter={16}>
                      <Col span={12}>
                        {result.boundaryNotes.length ? (
                          <Card title="可信度与边界" className="page-card module-section-card">
                            <List
                              size="small"
                              dataSource={result.boundaryNotes}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          </Card>
                        ) : null}
                      </Col>
                      <Col span={12}>
                        {result.warnings.length ? (
                          <Card title="评审提醒" className="page-card module-section-card">
                            <List
                              size="small"
                              dataSource={result.warnings}
                              renderItem={(item) => <List.Item>{item}</List.Item>}
                            />
                          </Card>
                        ) : null}
                      </Col>
                    </Row>
                  ) : null}
                </>
              ) : (
                <Empty description="上传设计稿并点击「开始评审」查看结果" />
              )}
            </div>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
};

function ReviewerCard({ reviewer }: { reviewer: VisualReviewerResult }) {
  const dimensions = reviewer.dimensions ?? [];
  const issues = reviewer.issues ?? [];
  const rich = dimensions.length > 0 || issues.length > 0;
  return (
    <Card
      type="inner"
      className="vision-reviewer-card"
      title={reviewer.roleLabel ?? reviewer.role}
      extra={<Tag color="green">评分 {roundScore(reviewer)}/10</Tag>}
    >
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        {reviewer.actualModel ? (
          <Space wrap>
            <Tag color="blue">实际模型：{reviewer.actualModel}</Tag>
          </Space>
        ) : null}

        {rich ? (
          <>
            {dimensions.length ? (
              <div className="vision-reviewer-section">
                <Text strong>维度评审</Text>
                <List
                  size="small"
                  dataSource={dimensions}
                  renderItem={(item) => (
                    <List.Item>
                      <Space direction="vertical" size={10}>
                        <Space wrap>
                          <Text strong>{item.name}</Text>
                          {item.score !== undefined ? <Tag color="blue">{item.score}/10</Tag> : null}
                        </Space>
                        {item.evidence ? <Text>{item.evidence}</Text> : null}
                        {item.suggestion ? (
                          <Text type="secondary">建议：{item.suggestion}</Text>
                        ) : null}
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            ) : null}

            {issues.length ? (
              <div className="vision-reviewer-section">
                <Text strong>问题清单</Text>
                <List
                  size="small"
                  dataSource={issues}
                  renderItem={(item) => (
                    <List.Item>
                      <Space direction="vertical" size={10}>
                        <Tag
                          color={
                            item.severity === 'high'
                              ? 'red'
                              : item.severity === 'medium'
                                ? 'orange'
                                : 'blue'
                          }
                        >
                          {item.severity}
                        </Tag>
                        <Text>{item.issue}</Text>
                        {item.suggestion ? (
                          <Text type="secondary">建议：{item.suggestion}</Text>
                        ) : null}
                      </Space>
                    </List.Item>
                  )}
                />
              </div>
            ) : null}

            {reviewer.topSuggestion ? (
              <Alert type="info" showIcon message={`该角色最高优先建议：${reviewer.topSuggestion}`} />
            ) : null}
          </>
        ) : (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {reviewer.findings.length ? <Text>{reviewer.findings.join(' ')}</Text> : null}
            {reviewer.suggestions.length ? (
              <Text type="secondary">{reviewer.suggestions.join('；')}</Text>
            ) : null}
          </Space>
        )}
      </Space>
    </Card>
  );
}

function BrandCard({ ba }: { ba: BrandAssociationResult }) {
  return (
    <Card title="品牌联想度" className="page-card module-section-card">
      {ba.status === 'available' ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div className="brand-hero-score">{ba.score ?? '-'}</div>
          <Paragraph className="brand-hero-caption">{ba.summary}</Paragraph>
          <Space wrap>
            {ba.vectorBackend ? <Tag color="blue">向量后端：{ba.vectorBackend}</Tag> : null}
            {ba.vectorDimension ? <Tag>维度：{ba.vectorDimension}</Tag> : null}
            <Tag>参考图 {ba.referenceSampleCount} 张</Tag>
          </Space>
        </Space>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={ba.summary} />
      )}
    </Card>
  );
}
