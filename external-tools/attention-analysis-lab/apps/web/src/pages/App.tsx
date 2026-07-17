import { UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  ConfigProvider,
  Empty,
  List,
  Layout,
  Menu,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useRef, useState } from 'react';
import type { AttentionAnalyzeResult, UploadedImageRef } from '@attention-analysis-lab/core';
import { analyze, uploadImage } from '../lib/api.js';
import './styles.css';

const { Header, Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;

export const App = () => {
  const [image, setImage] = useState<UploadedImageRef>();
  const [preview, setPreview] = useState<string>();
  const [result, setResult] = useState<AttentionAnalyzeResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(undefined);
    try {
      setPreview(URL.createObjectURL(file));
      setImage(await uploadImage(file));
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
          image,
          mode: 'hybrid',
          rois: [
            { id: 'hero', label: '主视觉', x: 0.1, y: 0.1, width: 0.52, height: 0.38 },
            { id: 'cta', label: '行动按钮', x: 0.58, y: 0.62, width: 0.28, height: 0.18 },
          ],
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enginePill =
    result?.engine === 'vlm'
      ? '真实 VLM'
      : result?.engine === 'heuristic'
        ? '启发式降级'
        : undefined;

  return (
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 14, colorPrimary: '#d46b08' } }}>
      <Layout className="app-shell">
        <Sider width={240} theme="light" className="app-shell-sider">
          <div className="app-shell-brand">
            <div className="app-shell-brand-kicker">Research OS</div>
            <div className="app-shell-brand-title">AI 用研分析系统</div>
          </div>
          <Menu
            selectedKeys={['attention']}
            mode="inline"
            items={[{ key: 'attention', label: '注意力分析' }]}
          />
        </Sider>
        <Layout className="app-shell-main">
          <Header className="app-shell-header">
            <div className="app-shell-header-kicker">Workspace</div>
            <div className="app-shell-header-title">注意力分析</div>
            <div className="app-shell-header-subtitle">
              VLM 语义注意力模拟：第一眼焦点、热力分布、ROI 排序与分散风险
            </div>
          </Header>
          <Content className="app-shell-content">
            <div className="app-shell-content-inner">
              {/* ---------- 操作区 ---------- */}
              <Card className="page-card" title="发起分析">
                <Space direction="vertical" size={18} style={{ width: '100%' }}>
                  <div className="lab-uploader">
                    <Text type="secondary" style={{ fontWeight: 600 }}>设计稿 *</Text>
                    {preview ? (
                      <img className="lab-uploader-preview" src={preview} alt="设计稿预览" />
                    ) : null}
                    <div>
                      <Button icon={<UploadOutlined />} onClick={() => fileRef.current?.click()}>
                        上传设计稿
                      </Button>
                      {image ? (
                        <Text type="secondary" style={{ marginLeft: 12 }}>
                          已上传：{image.fileName || image.id}
                        </Text>
                      ) : null}
                    </div>
                    <input
                      ref={fileRef}
                      hidden
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        void onFile(e.target.files?.[0]);
                        e.currentTarget.value = '';
                      }}
                    />
                  </div>
                  <Button
                    type="primary"
                    size="large"
                    loading={busy}
                    disabled={!image}
                    onClick={() => void run()}
                  >
                    开始注意力分析
                  </Button>
                </Space>
              </Card>

              {error ? <Alert type="error" showIcon message="分析失败" description={error} /> : null}

              {/* ---------- 结果区 ---------- */}
              {result ? (
                <>
                  <div className="module-hero module-hero-aesthetic">
                    <div className="module-hero-main">
                      <Text className="module-hero-kicker">Attention Analysis</Text>
                      <Title level={2} className="module-hero-title">
                        注意力分析
                      </Title>
                      <Paragraph className="module-hero-description">
                        估算页面第一眼焦点、热力分布、ROI 排序与分散风险。
                      </Paragraph>
                      <div className="module-hero-meta">
                        <Text className="module-hero-pill">语义注意力模拟</Text>
                        <Text className="module-hero-pill">热力 + ROI 排序</Text>
                        {enginePill ? <Text className="module-hero-pill">{enginePill}</Text> : null}
                      </div>
                    </div>
                  </div>

                  <div className="attn-metric-grid">
                    <Card className="attn-metric-card attn-metric-card-hl">
                      <Statistic title="峰值注意力" value={result.peakAttentionScore} />
                    </Card>
                    <Card className="attn-metric-card">
                      <Statistic title="焦点平衡" value={result.focusBalanceScore} />
                    </Card>
                    <Card className="attn-metric-card">
                      <Statistic title="分散风险" value={result.distractionRiskScore} />
                    </Card>
                    <Card className="attn-metric-card">
                      <Statistic title="热点数" value={result.hotspots.length} />
                    </Card>
                  </div>

                  {result.summary ? (
                    <Alert type="info" showIcon message="概览" description={result.summary} />
                  ) : null}

                  <div className="attn-two-col">
                    <Card title="注意力热区（叠加设计图）" className="page-card module-section-card">
                      {preview ? (
                        <div className="attn-stage">
                          <img className="attn-base" src={preview} alt="设计稿" />
                          {result.heatmapImage ? (
                            <img className="attn-heat" src={result.heatmapImage} alt="热力图" />
                          ) : null}
                          {result.hotspots.map((h) => (
                            <div
                              key={h.id}
                              className="attn-hotbox"
                              style={{
                                left: `${h.x * 100}%`,
                                top: `${h.y * 100}%`,
                                width: `${h.width * 100}%`,
                                height: `${h.height * 100}%`,
                              }}
                            >
                              <span>{Math.round(h.score * 100)}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可预览的设计稿" />
                      )}
                    </Card>

                    <Card title="吸睛热点（按优先级）" className="page-card module-section-card">
                      {result.hotspots.length ? (
                        <List
                          dataSource={result.hotspots}
                          renderItem={(h) => (
                            <List.Item>
                              <div className="attn-hotspot-item">
                                <div className="attn-hotspot-head">
                                  <Text strong>{h.label ?? h.id}</Text>
                                  <Tag color="orange">{h.score}</Tag>
                                </div>
                                <Text type="secondary">{h.reason}</Text>
                              </div>
                            </List.Item>
                          )}
                        />
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未识别到显著热点" />
                      )}
                    </Card>
                  </div>

                  {result.roiAttentionRanking.length ? (
                    <Card title="ROI 注意力排名" className="page-card module-section-card">
                      <List
                        dataSource={result.roiAttentionRanking}
                        renderItem={(r) => (
                          <List.Item>
                            <div className="attn-hotspot-item">
                              <div className="attn-hotspot-head">
                                <div className="attn-rank-index">{r.attentionRank}</div>
                                <Text strong>{r.label}</Text>
                              </div>
                              <Space wrap>
                                <Tag>平均 {r.attentionAverage}</Tag>
                                <Tag>峰值 {r.attentionPeak}</Tag>
                                <Tag color="orange">占比 {r.attentionShare}</Tag>
                              </Space>
                            </div>
                          </List.Item>
                        )}
                      />
                    </Card>
                  ) : null}

                  {result.boundaryNotes.length || result.warnings.length ? (
                    <Row gutter={16}>
                      <Col span={12}>
                        {result.boundaryNotes.length ? (
                          <Card title="边界说明" className="page-card module-section-card">
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
                          <Card title="提醒" className="page-card module-section-card">
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
                <Empty description="上传设计稿并点击「开始注意力分析」查看结果" />
              )}
            </div>
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
};
